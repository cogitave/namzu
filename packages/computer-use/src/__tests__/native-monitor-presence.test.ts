/**
 * The native helper's foreground monitor and presence overlay, client side:
 * what is asked of the helper and how its answers become the interfaces the
 * ladder and the host already use. The helper is a fake that answers with the
 * lines of `conformance/namzu-win/`, which the Rust side is held to as well.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ForegroundLadder } from '../foreground/ladder.js'
import { createWindowsForegroundLadder } from '../foreground/windows.js'
import { NativeForegroundMonitor } from '../native/foreground-monitor.js'
import { NativePresence } from '../native/presence.js'
import type { NativeChannel } from '../native/process.js'
import { WindowsPresence } from '../presence/presence.js'
import { createWindowsPresence } from '../presence/windows.js'

const vectors = JSON.parse(
	readFileSync(
		fileURLToPath(new URL('../../../../conformance/namzu-win/protocol.json', import.meta.url)),
		'utf8',
	),
) as { replies: { name: string; op: string; wire: Record<string, unknown> }[] }

function vector(name: string): Record<string, unknown> {
	const found = vectors.replies.find((r) => r.name === name)
	if (!found) throw new Error(`no vector named ${name}`)
	return found.wire
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve()
}

class FakeHelper implements NativeChannel {
	readonly requests: Record<string, any>[] = []
	killed = false
	/** Replies by op, without an id. */
	answers: Record<string, Record<string, unknown>> = {
		hello: {
			ok: true,
			version: '0.1.0',
			buildHash: 'abc',
			arch: 'x86_64',
			osBuild: '26100',
			caps: ['monitor', 'rawinput', 'presence', 'foreground', 'lease'],
			dpiAwareness: 'perMonitorV2',
		},
		'monitor.start': vector('monitor.start, both watched'),
		'monitor.poll': vector('monitor.poll, input and a foreground change'),
		'foreground.get': vector('foreground.get, a window and its target'),
		'lease.begin': vector('lease.begin, held'),
		'lease.end': vector("lease.end, with the count of a person's input"),
		'presence.act': vector('presence.act'),
		'presence.hide': vector('presence.hide'),
	}
	private line: ((line: string) => void) | undefined

	write(line: string): void {
		const request = JSON.parse(line) as Record<string, any>
		this.requests.push(request)
		const answer = this.answers[request.op]
		if (answer) this.line?.(JSON.stringify({ ...answer, id: request.id }))
	}
	onLine(handler: (line: string) => void): void {
		this.line = handler
	}
	onExit(): void {}
	kill(): void {
		this.killed = true
	}
	ops(): string[] {
		return this.requests.map((r) => r.op)
	}
	last(op: string): Record<string, any> {
		const found = [...this.requests].reverse().find((r) => r.op === op)
		if (!found) throw new Error(`no ${op} request`)
		return found
	}
}

function monitor(fake: FakeHelper, toHelperPath?: (p: string) => string): NativeForegroundMonitor {
	return new NativeForegroundMonitor({
		executable: 'namzu-win.exe',
		spawnHelper: () => fake,
		...(toHelperPath ? { toHelperPath } : {}),
	})
}

describe('NativeForegroundMonitor', () => {
	it('starts the watch and is running once it does', async () => {
		const fake = new FakeHelper()
		const m = monitor(fake)
		expect(m.running).toBe(false)
		await m.start()
		expect(fake.ops()).toEqual(['hello', 'monitor.start'])
		expect(m.running).toBe(true)
	})

	it('refuses to start when raw input could not be registered', async () => {
		const fake = new FakeHelper()
		fake.answers['monitor.start'] = vector('monitor.start, raw input refused')
		await expect(monitor(fake).start()).rejects.toThrow(/keyboard and mouse/)
	})

	it('refuses a helper that has no monitor', async () => {
		const fake = new FakeHelper()
		fake.answers.hello = { ...fake.answers.hello, caps: ['uia'] } as Record<string, unknown>
		await expect(monitor(fake).start()).rejects.toThrow(/cannot watch/)
		expect(fake.ops()).not.toContain('monitor.start')
	})

	it('reads the desk as a person has used it, with the front window as a handle', async () => {
		const fake = new FakeHelper()
		const m = monitor(fake)
		await m.start()
		const state = await m.state({ pid: 4120 })
		expect(fake.last('foreground.get').processId).toBe(4120)
		expect(state.userInputs).toBe(42)
		expect(state.escapes).toBe(0)
		expect(state.foreground).toMatchObject({ hwnd: '0x10A2C', pid: 4120, exe: 'CalculatorApp.exe' })
		expect(state.target?.exe).toBeDefined()
		expect(state.desktop).toBe('Default')
	})

	it('begins a burst with the window, the idle gate and the lease file the helper clears if it dies', async () => {
		const fake = new FakeHelper()
		const m = monitor(fake, (p) => `\\\\wsl.localhost\\x${p}`)
		await m.start()
		const begun = await m.begin({
			leasePath: '/home/a/screen.lease',
			token: 't0k',
			raise: '0x10A2C',
			idleMs: 1500,
		})
		expect(fake.last('lease.begin')).toMatchObject({
			windowId: 'w:0000000000010a2c',
			raise: true,
			idleMs: 1500,
			leasePath: '\\\\wsl.localhost\\x/home/a/screen.lease',
			token: 't0k',
		})
		expect(begun.refused).toBe(false)
		expect(begun.userInputs).toBe(42)
	})

	it('begins without a raise when there is no window to raise', async () => {
		const fake = new FakeHelper()
		const m = monitor(fake)
		await m.start()
		await m.begin({ leasePath: 'p', token: 't' })
		expect(fake.last('lease.begin').raise).toBeUndefined()
		expect(fake.last('lease.begin').windowId).toBeUndefined()
	})

	it('ends a burst with what the helper counted of a person, and no Escape count', async () => {
		const fake = new FakeHelper()
		const m = monitor(fake)
		await m.start()
		const end = await m.end({ restore: true, keepCursor: true })
		expect(fake.last('lease.end')).toMatchObject({ restore: true, keepCursor: true })
		expect(end).toMatchObject({
			inputsDuring: 3,
			escapesDuring: 0,
			restoredForeground: true,
			inputMoved: true,
		})
	})

	it('counts no person at all when the helper did not watch the whole burst', async () => {
		const fake = new FakeHelper()
		const { inputsDuring: _gone, ...bare } = vector(
			"lease.end, with the count of a person's input",
		) as Record<string, unknown>
		fake.answers['lease.end'] = bare
		const m = monitor(fake)
		await m.start()
		expect((await m.end({ restore: false })).inputsDuring).toBe(0)
	})

	it('releases the lease file only while its token is the one given', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-lease-'))
		const file = join(dir, 'screen.lease')
		const m = monitor(new FakeHelper())
		writeFileSync(file, JSON.stringify({ token: 'mine' }))
		await m.release({ leasePath: file, token: 'other' })
		expect(existsSync(file)).toBe(true)
		await m.release({ leasePath: file, token: 'mine' })
		expect(existsSync(file)).toBe(false)
		// No file at all is not an error.
		await expect(m.release({ leasePath: file, token: 'mine' })).resolves.toBeUndefined()
	})

	it('never asks for what a key was: no request carries one', async () => {
		const fake = new FakeHelper()
		const m = monitor(fake)
		await m.start()
		await m.state()
		await m.begin({ leasePath: 'p', token: 't' })
		await m.end({ restore: false })
		for (const r of fake.requests) expect(Object.keys(r)).not.toContain('keys')
		expect(fake.ops().filter((o) => o.startsWith('monitor.') || o.startsWith('lease.'))).toEqual([
			'monitor.start',
			'monitor.poll',
			'lease.begin',
			'monitor.poll',
			'lease.end',
		])
	})
})

describe('NativePresence', () => {
	it('shows the overlay for an action: the window by handle, the kind and the point', async () => {
		const fake = new FakeHelper()
		const p = new NativePresence({ executable: 'namzu-win.exe', spawnHelper: () => fake })
		p.mark({ hwnd: 0x10a2c, kind: 'click', at: { x: 640.4, y: 480.6 } })
		await flush()
		expect(fake.last('presence.act')).toEqual({
			id: expect.any(Number),
			op: 'presence.act',
			windowId: 'w:0000000000010a2c',
			kind: 'click',
			at: { x: 640, y: 481 },
		})
		p.mark({ hwnd: 0x10a2c, kind: 'type' })
		await flush()
		expect(fake.last('presence.act').at).toBeUndefined()
	})

	it('hides only a helper that is running', async () => {
		const fake = new FakeHelper()
		const p = new NativePresence({ executable: 'namzu-win.exe', spawnHelper: () => fake })
		p.hide()
		await flush()
		expect(fake.requests).toEqual([])
		p.mark({ hwnd: 1, kind: 'move', at: { x: 1, y: 2 } })
		await flush()
		p.hide()
		await flush()
		expect(fake.ops()).toContain('presence.hide')
	})

	it('does not fail an action when the helper refuses or is missing', async () => {
		const fake = new FakeHelper()
		fake.answers['presence.act'] = { ok: false, code: 'not_found', message: 'no such window' }
		const p = new NativePresence({ executable: 'namzu-win.exe', spawnHelper: () => fake })
		expect(() => p.mark({ hwnd: 9, kind: 'click' })).not.toThrow()
		await flush()
		const none = new NativePresence({
			executable: 'x',
			spawnHelper: () => {
				throw new Error('no such file')
			},
		})
		expect(() => none.mark({ hwnd: 9, kind: 'click' })).not.toThrow()
		await flush()
	})

	it('ends the helper on release', async () => {
		const fake = new FakeHelper()
		const p = new NativePresence({ executable: 'namzu-win.exe', spawnHelper: () => fake })
		p.mark({ hwnd: 1, kind: 'click' })
		await flush()
		p.release()
		expect(fake.killed).toBe(true)
	})
})

describe('choosing the helper', () => {
	it('uses the native overlay when the helper is named, and PowerShell when it is not', () => {
		const env = { NAMZU_WIN_HELPER: 'C:\\n\\namzu-win.exe' }
		expect(createWindowsPresence({ env, platform: 'win32' })).toBeInstanceOf(NativePresence)
		expect(createWindowsPresence({ env: {}, platform: 'win32' })).toBeInstanceOf(WindowsPresence)
		expect(createWindowsPresence({ env: {}, platform: 'win32', helper: 'x.exe' })).toBeInstanceOf(
			NativePresence,
		)
	})

	it('has no overlay for a helper on a machine that cannot run it', () => {
		const wslProbes = { exists: () => false, readFile: () => undefined } as never
		expect(
			createWindowsPresence({ env: { NAMZU_WIN_HELPER: 'x' }, platform: 'linux', wslProbes }),
		).toBeUndefined()
		expect(
			createWindowsForegroundLadder({
				env: { NAMZU_WIN_HELPER: 'x' },
				platform: 'linux',
				wslProbes,
			}),
		).toBeUndefined()
	})

	it('builds the ladder on the native monitor when the helper is named', () => {
		const ladder = createWindowsForegroundLadder({
			env: { NAMZU_WIN_HELPER: 'C:\\n\\namzu-win.exe' },
			platform: 'win32',
		})
		expect(ladder).toBeInstanceOf(ForegroundLadder)
	})

	it('starts no process of its own: the helper process is the only one', () => {
		for (const rel of ['../native/presence.ts', '../native/foreground-monitor.ts']) {
			const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
			expect(text).not.toMatch(/child_process|spawn\(|EncodedCommand|Invoke-Expression/)
		}
	})
})
