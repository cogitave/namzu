/**
 * The presence overlay: the agent cursor and the border around the operated
 * window. These tests drive the host side with a fake helper; the drawing
 * itself is proven on a real desktop window (see the docs page).
 */
import { describe, expect, it } from 'vitest'
import type { WslProbes } from '../adapters/wsl.js'
import { presenceScriptLine } from '../presence/helper-script.js'
import {
	FADE_MS,
	GLIDE_MS,
	HOLD_MS,
	PRESENCE_BOOTSTRAP,
	PRESENCE_ENV,
	PRESENCE_HELPER_SCRIPT,
	type PresenceProcess,
	WindowsPresence,
	createWindowsPresence,
	presenceDisabledByEnv,
} from '../presence/index.js'

class FakeHelper implements PresenceProcess {
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
	says(line: string): void {
		this.line?.(line)
	}
	exits(): void {
		this.exit?.()
	}
}

function overlay(): { presence: WindowsPresence; helper: FakeHelper } {
	const helper = new FakeHelper()
	const presence = new WindowsPresence({ powershell: 'powershell.exe', spawnHelper: () => helper })
	return { presence, helper }
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('WindowsPresence', () => {
	it('starts the helper on the first mark, sends the script first, then the action once the helper says it is ready', async () => {
		const { presence, helper } = overlay()
		presence.mark({ hwnd: 0x1a2b, kind: 'click', at: { x: 100.6, y: 50.2 } })
		await flush()
		expect(helper.written).toEqual([presenceScriptLine()])
		helper.says('{"ok":true,"excluded":true,"error":""}')
		await flush()
		expect(helper.written).toHaveLength(2)
		expect(JSON.parse(helper.written[1] as string)).toEqual({
			cmd: 'act',
			hwnd: '0x1A2B',
			kind: 'click',
			x: 101,
			y: 50,
		})
	})

	it('reuses one helper for every later mark', async () => {
		let spawned = 0
		const helper = new FakeHelper()
		const presence = new WindowsPresence({
			powershell: 'powershell.exe',
			spawnHelper: () => {
				spawned += 1
				return helper
			},
		})
		presence.mark({ hwnd: 1, kind: 'click', at: { x: 1, y: 1 } })
		helper.says('{"ok":true,"excluded":true}')
		await flush()
		presence.mark({ hwnd: 1, kind: 'type' })
		presence.mark({ hwnd: 2, kind: 'click', at: { x: 5, y: 5 } })
		await flush()
		expect(spawned).toBe(1)
		const acts = helper.written.slice(1).map((line) => JSON.parse(line))
		expect(acts.map((act) => act.kind)).toEqual(['click', 'type', 'click'])
		// Typing carries no point: the cursor stays where it is.
		expect(acts[1]).not.toHaveProperty('x')
	})

	it('shows nothing when the helper cannot keep its windows out of captures', async () => {
		const { presence, helper } = overlay()
		presence.mark({ hwnd: 1, kind: 'click', at: { x: 1, y: 1 } })
		helper.says('{"ok":true,"excluded":false}')
		await flush()
		expect(helper.killed).toBe(true)
		expect(presence.available).toBe(false)
		presence.mark({ hwnd: 1, kind: 'click', at: { x: 1, y: 1 } })
		await flush()
		expect(helper.written).toEqual([presenceScriptLine()])
	})

	it('shows nothing and does not throw when the helper cannot start or exits', async () => {
		const failing = new WindowsPresence({
			powershell: 'powershell.exe',
			spawnHelper: () => {
				throw new Error('no powershell')
			},
		})
		expect(() => failing.mark({ hwnd: 1, kind: 'move' })).not.toThrow()
		await flush()
		expect(failing.available).toBe(false)

		// A helper that never came up stays off.
		const { presence, helper } = overlay()
		presence.mark({ hwnd: 1, kind: 'click', at: { x: 1, y: 1 } })
		helper.exits()
		await flush()
		expect(presence.available).toBe(false)
		presence.mark({ hwnd: 1, kind: 'click', at: { x: 2, y: 2 } })
		presence.hide()
		await flush()
		expect(helper.written).toHaveLength(1)
	})

	it('starts a helper that ended mid-session again on the next action, a few times, then stops trying', async () => {
		const helpers: FakeHelper[] = []
		const presence = new WindowsPresence({
			powershell: 'powershell.exe',
			spawnHelper: () => {
				const h = new FakeHelper()
				helpers.push(h)
				return h
			},
		})
		for (let i = 0; i < 3; i++) {
			presence.mark({ hwnd: 1, kind: 'click', at: { x: 1, y: 1 } })
			await flush()
			helpers[i]?.says('{"ok":true,"excluded":true}')
			await flush()
			helpers[i]?.exits()
			expect(presence.available).toBe(true)
		}
		presence.mark({ hwnd: 1, kind: 'click', at: { x: 1, y: 1 } })
		await flush()
		expect(helpers).toHaveLength(4)
		helpers[3]?.says('{"ok":true,"excluded":true}')
		await flush()
		helpers[3]?.exits()
		expect(presence.available).toBe(false)
	})

	it('hides at once on request, but never starts a helper just to hide', async () => {
		const { presence, helper } = overlay()
		presence.hide()
		await flush()
		expect(helper.written).toEqual([])
		presence.mark({ hwnd: 1, kind: 'click', at: { x: 1, y: 1 } })
		helper.says('{"ok":true,"excluded":true}')
		await flush()
		presence.hide()
		expect(JSON.parse(helper.written.at(-1) as string)).toEqual({ cmd: 'hide' })
	})

	it('can be started ahead of the first action, and only once', async () => {
		let spawned = 0
		const helper = new FakeHelper()
		const presence = new WindowsPresence({
			powershell: 'powershell.exe',
			spawnHelper: () => {
				spawned += 1
				return helper
			},
		})
		presence.warm()
		presence.warm()
		await flush()
		expect(spawned).toBe(1)
		expect(helper.written).toEqual([presenceScriptLine()])
	})

	it('closes the helper when disposed, and then ignores marks', async () => {
		const { presence, helper } = overlay()
		presence.mark({ hwnd: 1, kind: 'click', at: { x: 1, y: 1 } })
		helper.says('{"ok":true,"excluded":true}')
		await flush()
		await presence.dispose()
		expect(helper.killed).toBe(true)
		presence.mark({ hwnd: 1, kind: 'click', at: { x: 1, y: 1 } })
		await flush()
		expect(helper.written).toHaveLength(2)
	})
})

describe('the helper script', () => {
	it('keeps both windows click-through, unactivated, out of the taskbar and out of screen captures', () => {
		expect(PRESENCE_HELPER_SCRIPT).toContain('SetWindowDisplayAffinity(h, 0x11)')
		// WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW (layered is added after the exclusion).
		expect(PRESENCE_HELPER_SCRIPT).toContain('const uint EX = 0x20 | 0x08000000 | 0x80;')
		expect(PRESENCE_HELPER_SCRIPT).toContain(
			'SetWindowLong(h, -20, GetWindowLong(h, -20) | 0x80000)',
		)
		// The overlay must not ask for the foreground.
		expect(PRESENCE_HELPER_SCRIPT).not.toMatch(
			/SetForegroundWindow|BringWindowToTop|SwitchToThisWindow/,
		)
		expect(PRESENCE_HELPER_SCRIPT).not.toMatch(/SW_SHOW\b|ShowWindow\([a-z]+, 5\)/)
	})

	it('orders the overlay directly above the operated window explicitly, also for a window created after it', () => {
		// Ownership alone does not reorder a window already stacked above the overlay: the
		// placement must not carry SWP_NOZORDER (0x4), and an uncooperative neighbour is passed over.
		expect(PRESENCE_HELPER_SCRIPT).not.toMatch(/SetWindowPos\(frm, [^)]*0x4\)/)
		expect(PRESENCE_HELPER_SCRIPT).toContain('SetWindowPos(frm, ins, r.l, r.t, 0, 0, fl | 0x1)')
		expect(PRESENCE_HELPER_SCRIPT).toContain('ins = GetWindow(ins, 3)')
		// A hidden application window without a frame rectangle covers nothing and is not ordered against.
		expect(PRESENCE_HELPER_SCRIPT).toContain('if (!Rect(h, out o)) return false;')
	})

	it('works in physical pixels, whatever the display scaling', () => {
		expect(PRESENCE_HELPER_SCRIPT).toContain('SetThreadDpiAwarenessContext((IntPtr)(-4))')
		expect(
			PRESENCE_HELPER_SCRIPT.indexOf('SetThreadDpiAwarenessContext((IntPtr)(-4))'),
		).toBeLessThan(PRESENCE_HELPER_SCRIPT.indexOf('RegisterClassEx(ref c)'))
	})

	it('shows nothing if the capture exclusion did not take', () => {
		expect(PRESENCE_HELPER_SCRIPT).toContain('if (!Excluded) throw')
	})

	it('glides fast, and holds then fades after the last action', () => {
		expect(GLIDE_MS).toBeLessThanOrEqual(150)
		expect(HOLD_MS).toBeGreaterThan(0)
		expect(FADE_MS).toBeGreaterThan(0)
		expect(PRESENCE_HELPER_SCRIPT).toContain(`GlideMs = ${GLIDE_MS}`)
	})

	it('fits a Windows command line once started through the bootstrap', () => {
		const encoded = Buffer.from(PRESENCE_BOOTSTRAP, 'utf16le').toString('base64')
		expect(encoded.length).toBeLessThan(2_000)
		expect(Buffer.from(presenceScriptLine(), 'base64').toString('utf8')).toBe(
			PRESENCE_HELPER_SCRIPT,
		)
	})
})

describe('createWindowsPresence', () => {
	const wsl = (powershell = true): WslProbes => ({
		readFile: (path) =>
			path === '/proc/sys/kernel/osrelease' ? '6.6.87.2-microsoft-standard-WSL2' : undefined,
		exists: (path) => powershell && path.endsWith('powershell.exe'),
		interopSockets: () => [],
	})

	it('is on by default under WSL and on Windows', () => {
		expect(createWindowsPresence({ env: {}, platform: 'linux', wslProbes: wsl() })).toBeInstanceOf(
			WindowsPresence,
		)
		expect(createWindowsPresence({ env: {}, platform: 'win32' })).toBeInstanceOf(WindowsPresence)
	})

	it('is off when the option or the environment says so', () => {
		expect(createWindowsPresence({ env: {}, platform: 'win32', enabled: false })).toBeUndefined()
		for (const value of ['off', '0', 'false', 'NO', ' none ']) {
			expect(
				createWindowsPresence({ env: { [PRESENCE_ENV]: value }, platform: 'win32' }),
			).toBeUndefined()
			expect(presenceDisabledByEnv({ [PRESENCE_ENV]: value })).toBe(true)
		}
		expect(presenceDisabledByEnv({ [PRESENCE_ENV]: 'on' })).toBe(false)
		expect(presenceDisabledByEnv({})).toBe(false)
	})

	it('is absent where there is no Windows PowerShell', () => {
		expect(
			createWindowsPresence({ env: {}, platform: 'linux', wslProbes: wsl(false) }),
		).toBeUndefined()
		expect(createWindowsPresence({ env: {}, platform: 'darwin' })).toBeUndefined()
	})
})
