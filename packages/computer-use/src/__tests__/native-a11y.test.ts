/**
 * The native helper's client side: the process (greeting, correlation, limits,
 * restart, cancel) and the accessibility backend on top of it. They are driven
 * by a fake helper that answers with the lines of `conformance/namzu-win/`,
 * the same lines the Rust side is held to, so a reply the real helper writes
 * and a reply this test reads cannot drift apart.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { A11yError, createWindowsA11yHost } from '../a11y/index.js'
import { NativeA11yBackend } from '../native/a11y.js'
import { type NativeChannel, NativeWinProcess } from '../native/process.js'

function vectors(name: string): Record<string, any> {
	const url = new URL(`../../../../conformance/namzu-win/${name}`, import.meta.url)
	return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))
}

const REPLIES: { name: string; op: string; wire: Record<string, unknown> }[] =
	vectors('protocol.json').replies

function reply(name: string): Record<string, unknown> {
	const found = REPLIES.find((r) => r.name === name)
	if (!found) throw new Error(`no vector named ${name}`)
	return found.wire
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** A helper that answers each request with the vector named for its op. */
class FakeHelper implements NativeChannel {
	readonly requests: Record<string, any>[] = []
	killed = false
	/** Which vector answers which op; the default is the first vector of that op. */
	answers: Record<string, string> = {}
	/** Exact replies (without an id) for ops the vectors do not cover. */
	raw: Record<string, Record<string, unknown>> = {}
	/** Ops the fake leaves unanswered. */
	silent = new Set<string>()
	private line: ((line: string) => void) | undefined
	private exit: (() => void) | undefined

	write(line: string): void {
		const request = JSON.parse(line) as Record<string, any>
		this.requests.push(request)
		if (this.silent.has(request.op)) return
		const wire = this.answerFor(request.op)
		if (wire) this.says({ ...wire, id: request.id })
	}

	private answerFor(op: string): Record<string, unknown> | undefined {
		const raw = this.raw[op]
		if (raw) return raw
		const named = this.answers[op]
		if (named) return reply(named)
		return REPLIES.find((r) => r.op === op)?.wire
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
	ops(): string[] {
		return this.requests.map((r) => r.op)
	}
}

function backend(
	options: {
		maxRestarts?: number
		startTimeoutMs?: number
		configure?: (helper: FakeHelper) => void
	} = {},
) {
	const { configure, ...rest } = options
	const helpers: FakeHelper[] = []
	const client = new NativeA11yBackend({
		executable: 'C:\\namzu\\namzu-win.exe',
		cliVersion: '55.0.0',
		spawnHelper: () => {
			const h = new FakeHelper()
			configure?.(h)
			helpers.push(h)
			return h
		},
		...rest,
	})
	return { client, helpers }
}

afterEach(() => {
	vi.useRealTimers()
})

describe('the native helper process', () => {
	it('starts nothing until it is used', () => {
		const { helpers } = backend()
		expect(helpers).toHaveLength(0)
	})

	it('greets the helper in namzu-win/1 and is ready once it answers', async () => {
		const { client, helpers } = backend()
		expect(client.isReady).toBe(false)
		expect(await client.ready()).toBe(true)
		expect(client.isReady).toBe(true)
		expect(helpers[0]?.requests[0]).toEqual({
			id: 1,
			op: 'hello',
			protocol: 'namzu-win/1',
			cliVersion: '55.0.0',
		})
	})

	it('stays off when the helper refuses the greeting', async () => {
		const { client, helpers } = backend({
			configure: (h) => {
				h.raw.hello = {
					ok: false,
					code: 'protocol_mismatch',
					message: 'this helper speaks namzu-win/2',
				}
			},
		})
		expect(await client.ready()).toBe(false)
		expect(helpers[0]?.killed).toBe(true)
		await expect(client.listDisplays()).rejects.toMatchObject({ code: 'unavailable' })
	})

	it('stays off when the helper says nothing', async () => {
		vi.useFakeTimers()
		const { client } = backend({
			startTimeoutMs: 500,
			configure: (h) => h.silent.add('hello'),
		})
		const ready = client.ready()
		await vi.advanceTimersByTimeAsync(600)
		expect(await ready).toBe(false)
	})

	it('answers each request with its own reply even when they arrive out of order', async () => {
		const { client, helpers } = backend()
		await client.ready()
		const helper = helpers[0] as FakeHelper
		helper.silent.add('windows')
		helper.silent.add('displays')
		const windows = client.listWindows()
		const displays = client.listDisplays()
		await flush()
		const [w, d] = helper.requests.slice(-2) as [Record<string, any>, Record<string, any>]
		helper.says({ ...reply('displays'), id: d.id })
		helper.says({ ...reply('two windows'), id: w.id })
		expect((await displays)[0]?.id).toBe('d:1')
		expect(await windows).toHaveLength(2)
	})

	it('turns a failure reply into an A11yError with the helper code', async () => {
		const { client, helpers } = backend()
		await client.ready()
		const helper = helpers[0] as FakeHelper
		helper.answers.windows = 'a failure with a code a newer helper added'
		const error = await client.listWindows().catch((e: unknown) => e)
		expect(error).toBeInstanceOf(A11yError)
		expect((error as A11yError).code).toBe('something_new')
	})

	it('refuses a reply that is not the shape the op promises', async () => {
		const { client, helpers } = backend()
		await client.ready()
		const helper = helpers[0] as FakeHelper
		helper.silent.add('displays')
		const pending = client.listDisplays()
		await flush()
		helper.says({ id: helper.requests.at(-1)?.id, ok: true, displays: 'many' })
		await expect(pending).rejects.toMatchObject({ code: 'bad_reply' })
	})

	it('ignores a line that is not JSON or names no waiting request', async () => {
		const { client, helpers } = backend()
		await client.ready()
		const helper = helpers[0] as FakeHelper
		helper.says('not json')
		helper.says({ id: 999, ok: true })
		helper.says({ ev: 'something' })
		expect((await client.listDisplays()).length).toBeGreaterThan(0)
	})

	it('gives up on a helper that never answers, and tells it to stop', async () => {
		vi.useFakeTimers()
		const { client, helpers } = backend()
		const up = client.ready()
		await vi.advanceTimersByTimeAsync(0)
		await up
		const helper = helpers[0] as FakeHelper
		helper.silent.add('snapshot')
		const pending = client.snapshot({ windowId: '0x10a2c', timeoutMs: 1_000 })
		const outcome = pending.catch((e: unknown) => e)
		await vi.advanceTimersByTimeAsync(3_000)
		expect(await outcome).toMatchObject({ code: 'timeout' })
		const snapshotId = helper.requests.find((r) => r.op === 'snapshot')?.id
		expect(helper.requests.at(-1)).toMatchObject({ op: 'cancel', target: snapshotId })
	})

	it('cancels at the helper when the caller aborts', async () => {
		const { client, helpers } = backend()
		await client.ready()
		const helper = helpers[0] as FakeHelper
		helper.silent.add('wait_change')
		const controller = new AbortController()
		const pending = client.waitForChange(
			{ windowId: '0x10a2c', timeoutMs: 5_000 },
			controller.signal,
		)
		await flush()
		const waitId = helper.requests.find((r) => r.op === 'wait_change')?.id
		controller.abort()
		await expect(pending).rejects.toMatchObject({ code: 'aborted' })
		expect(helper.requests.at(-1)).toMatchObject({ op: 'cancel', target: waitId })
	})

	it('does not even ask when the caller has already aborted', async () => {
		const { client, helpers } = backend()
		await client.ready()
		const controller = new AbortController()
		controller.abort()
		await expect(client.listDisplays(controller.signal)).rejects.toMatchObject({ code: 'aborted' })
		expect(helpers[0]?.ops()).toEqual(['hello'])
	})

	it('fails what was waiting when the helper ends, and starts it again for the next question', async () => {
		const { client, helpers } = backend()
		await client.ready()
		const first = helpers[0] as FakeHelper
		first.silent.add('displays')
		const pending = client.listDisplays()
		await flush()
		first.exits()
		await expect(pending).rejects.toMatchObject({ code: 'helper_exited' })
		expect(client.isReady).toBe(false)
		expect((await client.listDisplays()).length).toBeGreaterThan(0)
		expect(helpers).toHaveLength(2)
		expect(helpers[1]?.ops()).toEqual(['hello', 'displays'])
	})

	it('stops restarting a helper that keeps ending', async () => {
		const { client, helpers } = backend({ maxRestarts: 2 })
		for (let run = 0; run < 3; run++) {
			expect(await client.ready()).toBe(true)
			helpers[run]?.exits()
		}
		expect(await client.ready()).toBe(false)
		expect(helpers).toHaveLength(3)
		await expect(client.listDisplays()).rejects.toMatchObject({ code: 'unavailable' })
	})

	it('says quit and lets go when closed', async () => {
		const { client, helpers } = backend()
		await client.ready()
		await client.close()
		expect(helpers[0]?.ops()).toEqual(['hello', 'quit'])
		expect(helpers[0]?.killed).toBe(true)
		expect(client.isReady).toBe(false)
		await expect(client.listDisplays()).rejects.toBeInstanceOf(A11yError)
	})

	it('can be released and used again', async () => {
		const { client, helpers } = backend()
		await client.ready()
		client.release()
		expect(helpers[0]?.killed).toBe(true)
		expect(client.isReady).toBe(false)
		expect(await client.ready()).toBe(true)
		expect(helpers).toHaveLength(2)
	})

	it('exposes what the helper said in its greeting', async () => {
		const process = new NativeWinProcess({
			executable: 'x',
			spawnHelper: () => new FakeHelper(),
		})
		await process.ready()
		expect(process.hello).toMatchObject({ version: '0.1.0', dpiAwareness: 'perMonitorV2' })
	})
})

describe('the native accessibility backend', () => {
	it('lists windows under the ids callers already use, and remembers their processes', async () => {
		const { client, helpers } = backend({
			configure: (h) => {
				h.answers.windows = 'two windows'
			},
		})
		const windows = await client.listWindows({ includeOwned: true })
		expect(windows.map((w) => w.windowId)).toEqual(['0x10a2c', '0x209f0'])
		expect(windows[0]).toMatchObject({
			processId: 4120,
			processName: 'CalculatorApp.exe',
			focused: true,
		})
		expect(helpers[0]?.requests.at(-1)).toEqual({ id: 2, op: 'windows', includeOwned: true })
		await client.snapshot({ windowId: '0x10a2c' })
		expect(helpers[0]?.requests.at(-1)?.windowId).toBe('w:0000000000010a2c:4120')
	})

	it('names a window without its process when it has not seen one', async () => {
		const { client, helpers } = backend()
		await client.snapshot({ windowId: '0x1f' })
		expect(helpers[0]?.requests.at(-1)?.windowId).toBe('w:000000000000001f')
	})

	it('refuses an id it did not hand out', async () => {
		const { client } = backend()
		for (const id of ['', 'nope', '0x', '0', 'w:', 'w:zz:1']) {
			await expect(client.snapshot({ windowId: id })).rejects.toMatchObject({
				code: 'bad_window_id',
			})
		}
	})

	it('lists displays', async () => {
		const { client } = backend()
		const displays = await client.listDisplays()
		expect(displays).toHaveLength(2)
		expect(displays[0]).toMatchObject({ primary: true, scale: 1.5 })
	})

	it('reads a window into the nodes the host expects, without the helper-only ref', async () => {
		const { client, helpers } = backend()
		const snapshot = await client.snapshot({
			windowId: '0x10a2c',
			maxNodes: 50,
			maxDepth: 3,
			skeleton: true,
			allowChromium: true,
			timeoutMs: 2_500,
		})
		expect(helpers[0]?.requests.at(-1)).toMatchObject({
			op: 'snapshot',
			maxNodes: 50,
			maxDepth: 3,
			skeleton: true,
			allowChromium: true,
			timeoutMs: 2_500,
		})
		expect(snapshot.windowId).toBe('0x10a2c')
		expect(snapshot.revision).toBeGreaterThan(0)
		expect(snapshot.nodes.length).toBeGreaterThan(0)
		for (const node of snapshot.nodes) expect(node).not.toHaveProperty('ref')
		expect(snapshot.nodes[0]).toMatchObject({ index: 0, parent: -1 })
	})

	it('leaves out the options it was not given', async () => {
		const { client, helpers } = backend()
		await client.snapshot({ windowId: '0x10a2c' })
		const sent = helpers[0]?.requests.at(-1) ?? {}
		expect(Object.keys(sent).sort()).toEqual(['id', 'op', 'timeoutMs', 'windowId'])
	})

	it('names a control, with the revision it was read at', async () => {
		const { client, helpers } = backend()
		const fingerprint = await client.identity({ windowId: '0x10a2c', index: 3, revision: 2 })
		expect(helpers[0]?.requests.at(-1)).toMatchObject({ op: 'identity', index: 3, revision: 2 })
		expect(fingerprint).toMatchObject({ role: 'Button', automationId: 'num7Button' })
		await client.identity({ windowId: '0x10a2c', index: 3 })
		expect(helpers[0]?.requests.at(-1)).not.toHaveProperty('revision')
	})

	it('finds a control again', async () => {
		const { client, helpers } = backend()
		const fingerprint = await client.identity({ windowId: '0x10a2c', index: 3 })
		helpers[0]!.answers.resolve = 'resolved by automation id'
		expect(await client.resolve({ windowId: '0x10a2c', fingerprint })).toEqual({
			found: true,
			index: 12,
			via: 'automationId',
			revision: 4,
		})
		helpers[0]!.answers.resolve = 'ambiguous'
		expect(await client.resolve({ windowId: '0x10a2c', fingerprint })).toEqual({
			found: false,
			code: 'ambiguous',
			candidates: 3,
		})
		helpers[0]!.answers.resolve = 'not found'
		expect(await client.resolve({ windowId: '0x10a2c', fingerprint })).toEqual({
			found: false,
			code: 'not_found',
		})
	})

	it('numbers its markers by the helper run, so one from before a restart is refused', async () => {
		const { client, helpers } = backend()
		const marker = await client.seq('0x10a2c')
		expect(helpers[0]?.requests.at(-1)).toMatchObject({ op: 'seq', windowId: 'w:0000000000010a2c' })
		expect(marker).toBe(1 * 2 ** 40 + 18)
		helpers[0]?.exits()
		await client.ready()
		await expect(
			client.waitForChange({ windowId: '0x10a2c', since: marker }),
		).rejects.toMatchObject({
			code: 'stale_seq',
		})
		const fresh = await client.seq()
		expect(fresh).toBe(2 * 2 ** 40 + 18)
	})

	it('asks for a marker without a window without naming one', async () => {
		const { client, helpers } = backend()
		await client.seq()
		expect(helpers[0]?.requests.at(-1)).toEqual({ id: 2, op: 'seq' })
	})

	it('waits from a marker and reports the new windows under the ids callers use', async () => {
		const { client, helpers } = backend()
		const marker = await client.seq('0x10a2c')
		helpers[0]!.answers.wait_change = 'a wait that settled'
		const waited = await client.waitForChange({
			windowId: '0x10a2c',
			since: marker,
			quietMs: 200,
			timeoutMs: 4_000,
			kinds: ['structure', 'location'],
		})
		expect(helpers[0]?.requests.at(-1)).toMatchObject({
			op: 'wait_change',
			since: 18,
			quietMs: 200,
			timeoutMs: 4_000,
			kinds: ['structure', 'location'],
		})
		expect(waited).toMatchObject({ changed: true, settled: true })
		if (waited.changed) {
			for (const id of waited.newWindows) expect(id).toMatch(/^0x[0-9a-f]+$/)
		}
	})

	it('reports a wait that timed out', async () => {
		const { client, helpers } = backend()
		await client.ready()
		const helper = helpers[0] as FakeHelper
		helper.answers.wait_change = 'a wait that timed out'
		expect(await client.waitForChange({ windowId: '0x10a2c' })).toMatchObject({
			changed: false,
			timedOut: true,
		})
	})

	it('reports a change that came before the wait began', async () => {
		const { client, helpers } = backend()
		await client.ready()
		const helper = helpers[0] as FakeHelper
		helper.answers.wait_change = 'a wait whose change came before it started'
		const waited = await client.waitForChange({ windowId: '0x10a2c' })
		expect(waited).toMatchObject({ changed: true })
		if (waited.changed) expect(waited.firstEventMs).toBeLessThan(0)
	})
})

describe('choosing the native helper', () => {
	it('is chosen by NAMZU_WIN_HELPER on Windows, with no PowerShell', () => {
		const host = createWindowsA11yHost({
			platform: 'win32',
			env: { NAMZU_WIN_HELPER: 'C:\\namzu\\namzu-win.exe', PATH: 'x' },
		})
		expect(host?.id).toBe('native-uia')
	})

	it('is not chosen when the variable is unset or blank', () => {
		const host = createWindowsA11yHost({ platform: 'win32', env: { NAMZU_WIN_HELPER: '  ' } })
		expect(host?.id).toBe('windows-uia')
	})

	it('is not started by choosing it', () => {
		const spawn = vi.fn()
		const host = new NativeA11yBackend({ executable: 'x', spawnHelper: spawn })
		expect(host.isReady).toBe(false)
		expect(spawn).not.toHaveBeenCalled()
	})

	it('stays off when the accessibility host is turned off', () => {
		const host = createWindowsA11yHost({
			platform: 'win32',
			env: { NAMZU_WIN_HELPER: 'C:\\x.exe', NAMZU_COMPUTER_USE_A11Y: 'off' },
		})
		expect(host).toBeUndefined()
	})

	it('means nothing off Windows', () => {
		const host = createWindowsA11yHost({
			platform: 'linux',
			env: { NAMZU_WIN_HELPER: '/tmp/namzu-win.exe' },
			wslProbes: { readFile: () => undefined, exists: () => false, interopSockets: () => [] },
		})
		expect(host).toBeUndefined()
	})
})
