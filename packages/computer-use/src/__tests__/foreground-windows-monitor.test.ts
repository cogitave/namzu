import { describe, expect, it, vi } from 'vitest'
import { WINDOWS_HELPER_SCRIPT } from '../foreground/windows-helper-script.js'
import {
	HELPER_BOOTSTRAP,
	type HelperProcess,
	WindowsInputMonitor,
	encodeHelperCommand,
	helperScriptLine,
} from '../foreground/windows-monitor.js'
import { windowsPathFor } from '../foreground/windows.js'

/** A helper that answers from a script, one line per line written. */
function fakeHelper(
	hello: Record<string, unknown>,
	reply: (cmd: Record<string, unknown>) => unknown,
) {
	const written: Record<string, unknown>[] = []
	let line: (l: string) => void = () => undefined
	let exit: () => void = () => undefined
	let killed = 0
	const proc: HelperProcess = {
		write: (text) => {
			const cmd = JSON.parse(text) as Record<string, unknown>
			written.push(cmd)
			const answer = reply(cmd)
			if (answer !== undefined)
				queueMicrotask(() => line(JSON.stringify({ id: cmd.id, ...(answer as object) })))
		},
		onLine: (h) => {
			line = h
			queueMicrotask(() => line(JSON.stringify(hello)))
		},
		onExit: (h) => {
			exit = h
		},
		kill: () => {
			killed++
		},
	}
	return { proc, written, exitNow: () => exit(), killed: () => killed }
}

describe('the Windows input monitor', () => {
	it('starts when the hooks are installed and speaks one JSON line per command', async () => {
		const helper = fakeHelper({ ok: true, hooks: true }, (cmd) => ({
			ok: true,
			r:
				cmd.cmd === 'end'
					? {
							inputsDuring: 0,
							escapesDuring: 0,
							restoredForeground: true,
							restoredCursor: false,
						}
					: { userIdleMs: 5 },
		}))
		const monitor = new WindowsInputMonitor({
			powershell: 'ps',
			spawnHelper: () => helper.proc,
		})
		await monitor.start()
		await expect(monitor.state({ pid: 7 })).resolves.toMatchObject({
			userIdleMs: 5,
		})
		await monitor.begin({ leasePath: '/x/screen.lease', token: 't' })
		await expect(monitor.end({ restore: true })).resolves.toMatchObject({
			restoredForeground: true,
		})
		await monitor.release({ leasePath: '/x/screen.lease', token: 't' })
		expect(helper.written).toEqual([
			{ cmd: 'state', pid: 7, id: 1 },
			{ cmd: 'begin', lease: '/x/screen.lease', token: 't', id: 2 },
			{ cmd: 'end', restore: true, keepCursor: false, id: 3 },
			{ cmd: 'release', lease: '/x/screen.lease', token: 't', id: 4 },
		])
		await monitor.dispose()
		expect(helper.killed()).toBe(1)
	})

	it('refuses to start when the hooks could not be installed', async () => {
		const helper = fakeHelper(
			{ ok: true, hooks: false, hookError: 'SetWindowsHookEx failed 5' },
			() => undefined,
		)
		const monitor = new WindowsInputMonitor({
			powershell: 'ps',
			spawnHelper: () => helper.proc,
		})
		await expect(monitor.start()).rejects.toThrow('SetWindowsHookEx failed 5')
		expect(helper.killed()).toBe(1)
	})

	it('maps the lease path for Windows', async () => {
		const helper = fakeHelper({ ok: true, hooks: true }, () => ({
			ok: true,
			r: {},
		}))
		const monitor = new WindowsInputMonitor({
			powershell: 'ps',
			toWindowsPath: (p) => `W:${p}`,
			spawnHelper: () => helper.proc,
		})
		await monitor.start()
		await monitor.begin({ leasePath: '/a', token: 't' })
		expect(helper.written[0]).toMatchObject({ lease: 'W:/a' })
		expect(windowsPathFor('/home/u/.namzu/x', { WSL_DISTRO_NAME: 'Arch' })).toBe(
			'\\\\wsl.localhost\\Arch\\home\\u\\.namzu\\x',
		)
		expect(windowsPathFor('C:\\x', { WSL_DISTRO_NAME: 'Arch' })).toBe('C:\\x')
	})

	it('fails a command, not hangs, when the helper reports an error or exits', async () => {
		const helper = fakeHelper({ ok: true, hooks: true }, (cmd) =>
			cmd.cmd === 'state' ? { ok: false, error: 'boom' } : undefined,
		)
		const monitor = new WindowsInputMonitor({
			powershell: 'ps',
			spawnHelper: () => helper.proc,
		})
		await monitor.start()
		await expect(monitor.state()).rejects.toThrow('boom')
		const pending = monitor.begin({ leasePath: '/a', token: 't' })
		helper.exitNow()
		await expect(pending).rejects.toThrow(/exited/)
		await expect(monitor.state()).rejects.toThrow(/not running/)
	})

	it('drops the late reply of a request that timed out instead of handing it to the next one', async () => {
		vi.useFakeTimers()
		try {
			let lateLine: (l: string) => void = () => undefined
			const helper = fakeHelper({ ok: true, hooks: true }, (cmd) => {
				if (cmd.id === 1) return undefined
				return { ok: true, r: { userIdleMs: 42 } }
			})
			const monitor = new WindowsInputMonitor({
				powershell: 'ps',
				spawnHelper: () => {
					const original = helper.proc.onLine
					helper.proc.onLine = (h) => {
						lateLine = h
						original(h)
					}
					return helper.proc
				},
			})
			const started = monitor.start()
			await vi.advanceTimersByTimeAsync(0)
			await started
			const first = monitor.state()
			const firstError = expect(first).rejects.toThrow(/did not answer/)
			await vi.advanceTimersByTimeAsync(10_000)
			await firstError
			const second = monitor.state()
			// The first request's answer arrives now, after it gave up.
			lateLine(JSON.stringify({ id: 1, ok: true, r: { userIdleMs: 7 } }))
			await expect(second).resolves.toMatchObject({ userIdleMs: 42 })
		} finally {
			vi.useRealTimers()
		}
	})

	it('sends the idle requirement with begin, and the helper checks it before it raises', async () => {
		const helper = fakeHelper({ ok: true, hooks: true }, () => ({ ok: true, r: {} }))
		const monitor = new WindowsInputMonitor({ powershell: 'ps', spawnHelper: () => helper.proc })
		await monitor.start()
		await monitor.begin({ leasePath: '/a', token: 't', idleMs: 2000 })
		expect(helper.written[0]).toMatchObject({ idleMs: 2000 })
		const refuse = WINDOWS_HELPER_SCRIPT.indexOf('refused = $true')
		const raise = WINDOWS_HELPER_SCRIPT.indexOf('[NzG]::Raise($target)')
		expect(refuse).toBeGreaterThan(0)
		expect(refuse).toBeLessThan(raise)
	})

	it('puts a window back only when the burst moved the front, and says why when it did not', () => {
		// The window the helper raised, or, where that was refused and the driver took the front
		// itself, the target the burst was for: never a window some other program put in front.
		expect(WINDOWS_HELPER_SCRIPT).toMatch(
			/\$mine = if \(\$b\.raised -ne 0\) \{ \$b\.raised \} else \{ \$b\.target \}/,
		)
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/\$cur -ne \$mine/)
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/restoreNote/)
	})

	it('reads and writes an edit control by window message, never by focus or keys', async () => {
		const helper = fakeHelper({ ok: true, hooks: true }, () => ({
			ok: true,
			r: { found: true, reason: '', done: true, len: 5, text: '', seen: 'hello' },
		}))
		const monitor = new WindowsInputMonitor({ powershell: 'ps', spawnHelper: () => helper.proc })
		await monitor.start()
		const result = await monitor.editText({
			hwnd: '0x10',
			op: 'set',
			text: 'hello',
			pick: 'bounds',
			at: { x: 10.4, y: 20 },
		})
		expect(result).toMatchObject({ found: true, done: true, seen: 'hello' })
		expect(helper.written[0]).toMatchObject({
			cmd: 'edit',
			hwnd: '0x10',
			op: 'set',
			text: 'hello',
			pick: 'bounds',
			x: 10,
			y: 20,
		})
		// The script sends text as a message and reads it back; it raises nothing for it.
		// No focus window on a thread that is not active: the single edit control of the chosen
		// window, only when no other window of the thread is active; a focus elsewhere never falls back.
		expect(WINDOWS_HELPER_SCRIPT).toMatch(
			/g\.act == IntPtr\.Zero \|\| g\.act == t\) && found\.Count == 1/,
		)
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/Occ\(a, w\) > Occ\(b, w\)/)
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/0xC, IntPtr\.Zero, send/)
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/0xC2, \(IntPtr\)1, send/)
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/Marshal\.GetLastWin32Error\(\) == 5/)
	})

	it('selects a list row by its selection pattern, never by a click, and keeps the id as a tie-break only', async () => {
		const helper = fakeHelper({ ok: true, hooks: true }, () => ({
			ok: true,
			r: { found: true, reason: '', selected: true },
		}))
		const monitor = new WindowsInputMonitor({ powershell: 'ps', spawnHelper: () => helper.proc })
		await monitor.start()
		const result = await monitor.selectItem({
			hwnd: '0x10',
			role: 'ListItem',
			name: 'beta.txt',
			automationId: '1',
			bounds: { x: 10.4, y: 20, width: 300, height: 22 },
		})
		expect(result).toEqual({ found: true, reason: '', selected: true })
		expect(helper.written[0]).toMatchObject({
			cmd: 'select',
			hwnd: '0x10',
			role: 'ListItem',
			name: 'beta.txt',
			autoId: '1',
			x: 10,
			y: 20,
			w: 300,
			h: 22,
		})
		const from = WINDOWS_HELPER_SCRIPT.indexOf("'select' {")
		const select = WINDOWS_HELPER_SCRIPT.slice(from, WINDOWS_HELPER_SCRIPT.indexOf("'end' {", from))
		// A folder window's own view first (no focus, so the window is not brought forward), the pattern otherwise.
		expect(select).toMatch(/CabinetWClass/)
		expect(select).toMatch(/SelectItem\(\$items\[0\], 5\)/)
		expect(select).toMatch(/SelectionItemPattern\]::Pattern/)
		expect(select).toMatch(/\$o\.Select\(\)/)
		// The driver's id is not always the control's: it only narrows several matches.
		expect(select).toMatch(/\$hits\.Count -gt 1 -and \$c\.autoId/)
		expect(select).not.toMatch(/Invoke|SendInput|SetForegroundWindow/)
	})

	it('hands the helper to PowerShell through its input, not as a file or a command line', () => {
		// The command line carries only the bootstrap: the script itself would not fit in the
		// 32 767 characters a command line allows.
		const decoded = Buffer.from(encodeHelperCommand(), 'base64').toString('utf16le')
		expect(decoded).toBe(HELPER_BOOTSTRAP)
		expect(encodeHelperCommand().length).toBeLessThan(1_000)
		expect(Buffer.from(helperScriptLine(), 'base64').toString('utf8')).toBe(WINDOWS_HELPER_SCRIPT)
	})

	it('ends a burst in progress and deletes the lease when its input closes (the crash path)', () => {
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/EndBurst \$true \$false/)
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/Release \$keep\.lease \$keep\.token/)
		// Injected input is not the user's.
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/flags & 0x10\) == 0/)
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/flags & 1\) == 0/)
	})
})
