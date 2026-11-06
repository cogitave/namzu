/**
 * The accessibility host's client side: framing, correlation, limits,
 * restart, the environment switch and the change-marker contract. They drive
 * it with a fake helper; the helper itself is proven on a real desktop (see
 * the docs page for the numbers).
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	A11Y_ENV,
	A11yError,
	type A11yProcess,
	WindowsA11yHost,
	a11yDisabledByEnv,
	a11yScriptLine,
	createWindowsA11yHost,
} from '../a11y/index.js'
import type { WslProbes } from '../adapters/wsl.js'

class FakeHelper implements A11yProcess {
	readonly written: string[] = []
	killed = false
	private line: ((line: string) => void) | undefined
	private exit: (() => void) | undefined
	write(line: string): void {
		this.written.push(line)
	}
	onLine(handler: (line: string) => void): void {
		this.line = handler
	}
	onExit(handler: () => void): void {
		this.exit = handler
	}
	kill(): void {
		this.killed = true
	}
	says(value: unknown): void {
		this.line?.(typeof value === 'string' ? value : JSON.stringify(value))
	}
	exits(): void {
		this.exit?.()
	}
	/** The commands written after the script, parsed. */
	get commands(): Record<string, unknown>[] {
		return this.written.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>)
	}
	greet(): void {
		this.says({ id: null, ok: true, seq: 0, hello: true, version: 1 })
	}
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 8; i++) await Promise.resolve()
}

function host(options: { spawn?: () => A11yProcess } = {}) {
	const helpers: FakeHelper[] = []
	const client = new WindowsA11yHost({
		powershell: 'powershell.exe',
		spawnHelper:
			options.spawn ??
			(() => {
				const helper = new FakeHelper()
				helpers.push(helper)
				return helper
			}),
	})
	return { client, helpers }
}

async function ready(client: WindowsA11yHost, helpers: FakeHelper[]): Promise<void> {
	const up = client.ready()
	await flush()
	helpers.at(-1)?.greet()
	expect(await up).toBe(true)
}

afterEach(() => {
	vi.useRealTimers()
})

describe('WindowsA11yHost: starting', () => {
	it('starts nothing until it is used, then sends the script first and waits for the greeting', async () => {
		const { client, helpers } = host()
		expect(helpers).toHaveLength(0)
		expect(client.isReady).toBe(false)
		const up = client.ready()
		await flush()
		expect(helpers).toHaveLength(1)
		expect(helpers[0]?.written).toEqual([a11yScriptLine()])
		expect(client.isReady).toBe(false)
		helpers[0]?.greet()
		expect(await up).toBe(true)
		expect(client.isReady).toBe(true)
	})

	it('starts once however many times it is warmed or asked', async () => {
		const { client, helpers } = host()
		client.warm()
		client.warm()
		const first = client.ready()
		const second = client.ready()
		await flush()
		helpers[0]?.greet()
		expect(await Promise.all([first, second])).toEqual([true, true])
		expect(helpers).toHaveLength(1)
	})

	it('resolves false, and never throws, when PowerShell cannot be started', async () => {
		const { client } = host({
			spawn: () => {
				throw new Error('spawn powershell.exe ENOENT')
			},
		})
		await expect(client.ready()).resolves.toBe(false)
		expect(client.isReady).toBe(false)
		await expect(client.listWindows()).rejects.toMatchObject({ code: 'unavailable' })
	})

	it('resolves false when the greeting is not the one this client speaks', async () => {
		for (const greeting of ['not json', { ok: true, hello: true, version: 2 }, { ok: false }]) {
			const { client, helpers } = host()
			const up = client.ready()
			await flush()
			helpers[0]?.says(greeting)
			expect(await up).toBe(false)
			expect(helpers[0]?.killed).toBe(true)
			expect(client.isReady).toBe(false)
		}
	})

	it('resolves false when the helper ends before it greets, and stays off', async () => {
		const { client, helpers } = host()
		const up = client.ready()
		await flush()
		helpers[0]?.exits()
		expect(await up).toBe(false)
		await expect(client.ready()).resolves.toBe(false)
		expect(helpers).toHaveLength(1)
	})

	it('gives up on a helper that never greets', async () => {
		vi.useFakeTimers()
		const helper = new FakeHelper()
		const client = new WindowsA11yHost({
			powershell: 'powershell.exe',
			spawnHelper: () => helper,
			startTimeoutMs: 5_000,
		})
		const up = client.ready()
		await vi.advanceTimersByTimeAsync(5_000)
		expect(await up).toBe(false)
		expect(helper.killed).toBe(true)
	})
})

describe('WindowsA11yHost: asking', () => {
	it('answers each request from the reply that carries its id, in whatever order they come', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const helper = helpers[0] as FakeHelper
		const windows = client.listWindows()
		const displays = client.listDisplays()
		await flush()
		const [first, second] = helper.commands
		expect(first).toMatchObject({ cmd: 'windows' })
		expect(second).toMatchObject({ cmd: 'displays' })
		helper.says({
			id: second?.id,
			ok: true,
			displays: [
				{
					id: 'D1',
					x: 0,
					y: 0,
					width: 1920,
					height: 1080,
					workX: 0,
					workY: 0,
					workWidth: 1920,
					workHeight: 1040,
					scale: 1.5,
					primary: true,
				},
			],
		})
		helper.says({ id: first?.id, ok: true, windows: [] })
		await expect(windows).resolves.toEqual([])
		await expect(displays).resolves.toEqual([
			{
				id: 'D1',
				bounds: { x: 0, y: 0, width: 1920, height: 1080 },
				workArea: { x: 0, y: 0, width: 1920, height: 1040 },
				scale: 1.5,
				primary: true,
			},
		])
	})

	it('maps window records to the neutral shape, with ids in the 0x form the adapter uses', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const helper = helpers[0] as FakeHelper
		const listed = client.listWindows({ includeOwned: true })
		await flush()
		expect(helper.commands[0]).toMatchObject({ cmd: 'windows', includeOwned: true })
		helper.says({
			id: helper.commands[0]?.id,
			ok: true,
			windows: [
				{
					hwnd: 0x1a2b,
					pid: 42,
					process: 'app.exe',
					title: 'Notes',
					x: 10,
					y: 20,
					width: 300,
					height: 200,
					minimized: false,
					focused: true,
					z: 0,
				},
			],
		})
		await expect(listed).resolves.toEqual([
			{
				windowId: '0x1a2b',
				processId: 42,
				processName: 'app.exe',
				title: 'Notes',
				bounds: { x: 10, y: 20, width: 300, height: 200 },
				minimized: false,
				focused: true,
				z: 0,
			},
		])
	})

	it('maps a snapshot, sending the window as the number the helper wants and the limits it was given', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const helper = helpers[0] as FakeHelper
		const read = client.snapshot({
			windowId: '0x10',
			maxNodes: 50,
			skeleton: true,
			timeoutMs: 3_000,
		})
		await flush()
		expect(helper.commands[0]).toMatchObject({
			cmd: 'snapshot',
			hwnd: 16,
			maxNodes: 50,
			skeleton: true,
			timeoutMs: 3_000,
		})
		expect(helper.commands[0]).not.toHaveProperty('allowChromium')
		helper.says({
			id: helper.commands[0]?.id,
			ok: true,
			rev: 7,
			total: 2,
			truncated: false,
			skeleton: true,
			readMs: 11.5,
			nodes: [
				{ index: 0, parent: -1, depth: 0, role: 'Window', rect: [0, 0, 100, 80], enabled: true },
				{
					index: 1,
					parent: 0,
					depth: 1,
					role: 'Button',
					name: 'Save',
					rect: [5, 5, 20, 10],
					enabled: false,
					actions: ['invoke'],
					toggle: 'on',
					childCount: 3,
				},
			],
		})
		const snapshot = await read
		expect(snapshot).toMatchObject({ windowId: '0x10', revision: 7, total: 2, skeleton: true })
		expect(snapshot.nodes[1]).toEqual({
			index: 1,
			parent: 0,
			depth: 1,
			role: 'Button',
			name: 'Save',
			bounds: { x: 5, y: 5, width: 20, height: 10 },
			enabled: false,
			offscreen: false,
			focused: false,
			actions: ['invoke'],
			toggle: 'on',
			childCount: 3,
		})
	})

	it('refuses a window id it did not hand out, before anything is written', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		await expect(client.snapshot({ windowId: 'Notes' })).rejects.toMatchObject({
			code: 'bad_window_id',
		})
		expect(helpers[0]?.written).toHaveLength(1)
	})

	it('turns a failure reply into an A11yError with the helper code, and a chromium refusal is one', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const helper = helpers[0] as FakeHelper
		const read = client.snapshot({ windowId: '0x10' })
		await flush()
		helper.says({
			id: helper.commands[0]?.id,
			ok: false,
			code: 'chromium_not_activated',
			message: 'this window is a Chromium one',
		})
		const error = await read.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(A11yError)
		expect(error).toMatchObject({ code: 'chromium_not_activated' })
	})

	it('passes allowChromium only when asked for', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		void client.snapshot({ windowId: '0x10', allowChromium: true }).catch(() => undefined)
		await flush()
		expect(helpers[0]?.commands[0]).toMatchObject({ allowChromium: true })
	})

	it('ignores lines that are not replies to a request of its own', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const helper = helpers[0] as FakeHelper
		const listed = client.listWindows()
		await flush()
		helper.says('garbage')
		helper.says({ id: 999, ok: true })
		helper.says({ ok: true })
		helper.says({ id: helper.commands[0]?.id, ok: true, windows: [] })
		await expect(listed).resolves.toEqual([])
	})

	it('rejects a request the helper does not answer once its limit and the backstop have passed', async () => {
		vi.useFakeTimers()
		const helper = new FakeHelper()
		const client = new WindowsA11yHost({ powershell: 'powershell.exe', spawnHelper: () => helper })
		const up = client.ready()
		await vi.advanceTimersByTimeAsync(0)
		helper.greet()
		await up
		const listed = client.listWindows()
		const settled = listed.catch((e: unknown) => e)
		await vi.advanceTimersByTimeAsync(5_000)
		let done = false
		void settled.then(() => {
			done = true
		})
		await vi.advanceTimersByTimeAsync(0)
		expect(done).toBe(false)
		await vi.advanceTimersByTimeAsync(1_500)
		expect(await settled).toMatchObject({ code: 'timeout' })
		// A reply that comes after the give-up is dropped without harm.
		helper.says({ id: helper.commands[0]?.id, ok: true, windows: [] })
	})

	it('stops waiting when the call is cancelled, and never writes for one that already was', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const controller = new AbortController()
		const listed = client.listWindows({}, controller.signal)
		await flush()
		controller.abort()
		await expect(listed).rejects.toMatchObject({ code: 'aborted' })
		await expect(client.listWindows({}, controller.signal)).rejects.toMatchObject({
			code: 'aborted',
		})
		expect(helpers[0]?.written).toHaveLength(2)
	})
})

describe('WindowsA11yHost: the change marker', () => {
	it('hands out a marker, watches the window it was taken for, and counts events from it', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const helper = helpers[0] as FakeHelper

		const marker = client.seq('0x10')
		await flush()
		expect(helper.commands[0]).toMatchObject({ cmd: 'seq', hwnd: 16 })
		helper.says({ id: helper.commands[0]?.id, ok: true, seq: 41, armed: true })
		const since = await marker

		const waited = client.waitForChange({
			windowId: '0x10',
			since,
			quietMs: 120,
			timeoutMs: 500,
			kinds: ['property'],
		})
		await flush()
		// The helper is told the counter it handed out, not the client's token.
		expect(helper.commands[1]).toMatchObject({
			cmd: 'wait_change',
			hwnd: 16,
			since: 41,
			quietMs: 120,
			timeoutMs: 500,
			kinds: ['property'],
		})
		helper.says({
			id: helper.commands[1]?.id,
			ok: true,
			seq: 45,
			changed: true,
			settled: true,
			firstEventMs: -3.5,
			settledMs: 131,
			events: 4,
			newWindows: [0x2b],
		})
		await expect(waited).resolves.toEqual({
			changed: true,
			settled: true,
			firstEventMs: -3.5,
			settledMs: 131,
			events: 4,
			newWindows: ['0x2b'],
		})
	})

	it('takes a marker without a window as a plain counter read', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const helper = helpers[0] as FakeHelper
		const marker = client.seq()
		await flush()
		expect(helper.commands[0]).toEqual({ id: helper.commands[0]?.id, cmd: 'seq' })
		helper.says({ id: helper.commands[0]?.id, ok: true, seq: 7 })
		const since = await marker
		expect(typeof since).toBe('number')
	})

	it('reports a quiet window as not changed, without a since when none was given', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const helper = helpers[0] as FakeHelper
		const waited = client.waitForChange({ windowId: '0x10', timeoutMs: 400 })
		await flush()
		expect(helper.commands[0]).not.toHaveProperty('since')
		helper.says({
			id: helper.commands[0]?.id,
			ok: true,
			changed: false,
			timedOut: true,
			settledMs: 401,
		})
		await expect(waited).resolves.toEqual({ changed: false, timedOut: true, settledMs: 401 })
	})

	it('refuses a marker from before a restart instead of misreading it', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const first = helpers[0] as FakeHelper
		const marker = client.seq('0x10')
		await flush()
		first.says({ id: first.commands[0]?.id, ok: true, seq: 5, armed: true })
		const since = await marker

		first.exits()
		await flush()
		const next = client.ready()
		await flush()
		helpers[1]?.greet()
		expect(await next).toBe(true)
		await expect(client.waitForChange({ windowId: '0x10', since })).rejects.toMatchObject({
			code: 'stale_seq',
		})
		expect(helpers[1]?.written).toHaveLength(1)
	})
})

describe('WindowsA11yHost: a helper that ends', () => {
	it('fails what was waiting for it, starts one more helper for the next question, and then stays off', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const pending = client.listWindows()
		await flush()
		helpers[0]?.exits()
		await expect(pending).rejects.toMatchObject({ code: 'helper_exited' })
		expect(client.isReady).toBe(false)

		const again = client.listWindows()
		await flush()
		expect(helpers).toHaveLength(2)
		helpers[1]?.greet()
		await flush()
		helpers[1]?.says({ id: helpers[1]?.commands[0]?.id, ok: true, windows: [] })
		await expect(again).resolves.toEqual([])

		helpers[1]?.exits()
		await flush()
		await expect(client.listWindows()).rejects.toMatchObject({ code: 'unavailable' })
		await expect(client.ready()).resolves.toBe(false)
		expect(helpers).toHaveLength(2)
	})

	it('can be warmed back up after a crash', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		helpers[0]?.exits()
		await flush()
		client.warm()
		await flush()
		expect(helpers).toHaveLength(2)
	})

	it('says quit, kills the helper and refuses everything after close', async () => {
		const { client, helpers } = host()
		await ready(client, helpers)
		const pending = client.listWindows()
		await flush()
		await client.close()
		await expect(pending).rejects.toMatchObject({ code: 'closed' })
		expect(helpers[0]?.killed).toBe(true)
		expect(helpers[0]?.commands.at(-1)).toMatchObject({ cmd: 'quit' })
		expect(client.isReady).toBe(false)
		await expect(client.ready()).resolves.toBe(false)
		helpers[0]?.exits()
		await flush()
		expect(helpers).toHaveLength(1)
	})
})

describe('the environment switch and the factory', () => {
	const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
	const wsl = (present: boolean): WslProbes => ({
		readFile: (path) =>
			path === '/proc/sys/kernel/osrelease' ? '6.6.87.2-microsoft-standard-WSL2' : undefined,
		exists: (path) => present && path === POWERSHELL,
		interopSockets: () => [],
	})

	it('reads off, 0, false, no and none (any case) as off, and anything else as on', () => {
		for (const value of ['off', 'OFF', '0', 'false', 'No', ' none ']) {
			expect(a11yDisabledByEnv({ [A11Y_ENV]: value })).toBe(true)
		}
		for (const value of ['on', '1', 'true', '']) {
			expect(a11yDisabledByEnv({ [A11Y_ENV]: value })).toBe(false)
		}
		expect(a11yDisabledByEnv({})).toBe(false)
	})

	it('builds nothing when switched off, whatever the machine', () => {
		expect(
			createWindowsA11yHost({
				env: { [A11Y_ENV]: 'off' },
				platform: 'linux',
				wslProbes: wsl(true),
			}),
		).toBeUndefined()
		expect(
			createWindowsA11yHost({ enabled: false, platform: 'linux', wslProbes: wsl(true) }),
		).toBeUndefined()
	})

	it('builds nothing where there is no Windows PowerShell, and a lazy host where there is', () => {
		expect(
			createWindowsA11yHost({ env: {}, platform: 'linux', wslProbes: wsl(false) }),
		).toBeUndefined()
		expect(createWindowsA11yHost({ env: {}, platform: 'darwin' })).toBeUndefined()
		const built = createWindowsA11yHost({ env: {}, platform: 'linux', wslProbes: wsl(true) })
		expect(built).toBeInstanceOf(WindowsA11yHost)
		expect(built?.isReady).toBe(false)
	})
})

describe('the helper and its client agree', () => {
	const script = readFileSync(new URL('../a11y/a11y-script.ts', import.meta.url), 'utf8')
	const client = readFileSync(new URL('../a11y/a11y.ts', import.meta.url), 'utf8')

	const inScript = [...script.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1] as string)
	const sent = new Set([
		...[...client.matchAll(/this\.request\(\s*'([a-z_]+)'/g)].map((m) => m[1] as string),
		// close() writes it directly.
		...[...client.matchAll(/cmd: '([a-z_]+)'/g)].map((m) => m[1] as string),
	])

	it('every command the client sends is one the script handles', () => {
		expect([...sent].length).toBeGreaterThanOrEqual(8)
		for (const cmd of sent) expect(inScript).toContain(cmd)
	})

	it('every command the script handles is one the client can send', () => {
		// `hello` is the same body the helper volunteers as its first line, which is how the client learns it is up.
		for (const cmd of inScript.filter((c) => c !== 'hello')) expect([...sent]).toContain(cmd)
	})

	it('the script is the hello the client expects', () => {
		expect(script).toContain('static string Hello()')
		expect(script).toContain('\\"hello\\":true,\\"version\\":" + Version')
		expect(script).toContain('const int Version = 1;')
		expect(client).toContain('const PROTOCOL_VERSION = 1')
	})

	it('never reads a Chromium window without being asked, and listens to a Chromium window by system events only', () => {
		expect(script).toContain('chromium_not_activated')
		expect(script).toContain('if (GetB(req, "allowChromium", false)) return;')
		expect(script).toContain('if (!ChromiumClass(ClassOf(h))) {')
	})

	it('never asks for the foreground, and never calls accessibility from an event handler', () => {
		expect(script).not.toMatch(
			/SetForegroundWindow|BringWindowToTop|SwitchToThisWindow|ShowWindow\(/,
		)
		// The two handlers only record.
		expect(script).toContain('AddEv(1, 1, hw, hw, pid, false); };')
		expect(script).toContain('AddEv(1, 2, hw, hw, pid, false); };')
	})
})
