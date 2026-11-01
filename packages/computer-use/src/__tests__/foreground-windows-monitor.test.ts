import { describe, expect, it, vi } from 'vitest'
import { WINDOWS_HELPER_SCRIPT } from '../foreground/windows-helper-script.js'
import {
	type HelperProcess,
	WindowsInputMonitor,
	encodeHelperCommand,
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

	it('puts a window back only when the burst raised one that is still in front', () => {
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/\$b\.raised -ne 0/)
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/\$cur -eq \$b\.raised/)
	})

	it('hands the helper to PowerShell as an encoded command, not as a file', () => {
		const decoded = Buffer.from(encodeHelperCommand(), 'base64').toString('utf16le')
		expect(decoded).toBe(WINDOWS_HELPER_SCRIPT)
		// The command line limit is 32 767 characters.
		expect(encodeHelperCommand().length).toBeLessThan(30_000)
	})

	it('ends a burst in progress and deletes the lease when its input closes (the crash path)', () => {
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/EndBurst \$true \$false/)
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/Release \$keep\.lease \$keep\.token/)
		// Injected input is not the user's.
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/flags & 0x10\) == 0/)
		expect(WINDOWS_HELPER_SCRIPT).toMatch(/flags & 1\) == 0/)
	})
})
