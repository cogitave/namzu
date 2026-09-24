/**
 * Desktop notifications carry data, never code: title and body reach the
 * other program as argv or environment, stripped of control and bidi
 * characters, and a WSL toast names its variables in WSLENV so Windows
 * receives them at all.
 */

import { describe, expect, it } from 'vitest'
import { noticeText } from '../../schedule/daemon/notify.js'
import { type Spawn, selectDesktopBackend, sendDesktopNotification } from './desktop.js'
import { gdbusArguments, gvariantString } from './desktop/freedesktop.js'
import { sanitizeLine, summaryOf } from './desktop/sanitize.js'
import { TOAST_SCRIPT, encodedToastScript, toastScriptHash } from './desktop/windows-toast.js'

const HOSTILE = '"; Remove-Item -Recurse C:\\ # </text><action/>'

function recorder() {
	const calls: {
		command: string
		args: readonly string[]
		env: NodeJS.ProcessEnv
		cwd?: string
	}[] = []
	const spawn: Spawn = async (command, args, options) => {
		calls.push({ command, args, env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}) })
		return { code: 0, stderr: '' }
	}
	return { calls, spawn }
}

const wslProbe = {
	platform: 'linux' as const,
	env: {
		WSL_DISTRO_NAME: 'arch',
		WSL_INTEROP: '/run/WSL/1_interop',
		WSLENV: 'WT_SESSION:USERPROFILE/p',
	},
	exists: () => true,
	mountRoot: '/mnt/',
}

describe('a WSL toast', () => {
	it('passes title and body through the environment and names them in WSLENV', async () => {
		const backend = selectDesktopBackend(wslProbe)
		expect(backend.kind).toBe('wsl-toast')
		const { calls, spawn } = recorder()
		const hash = toastScriptHash()
		await sendDesktopNotification(
			backend,
			{ title: 'namzu: nightly', body: HOSTILE },
			{ env: wslProbe.env, spawn },
		)
		const call = calls[0]
		expect(call?.env.WSLENV).toBe('WT_SESSION:USERPROFILE/p:NAMZU_NOTIFY_TITLE:NAMZU_NOTIFY_BODY')
		expect(call?.env.NAMZU_NOTIFY_BODY).toBe(HOSTILE)
		expect(call?.args.at(-2)).toBe('-EncodedCommand')
		expect(call?.args.at(-1)).toBe(encodedToastScript())
		expect(call?.args.join(' ')).not.toContain('Remove-Item')
		expect(call?.cwd).toBe('/mnt/c')
		expect(toastScriptHash()).toBe(hash)
		expect(TOAST_SCRIPT).toContain('[Security.SecurityElement]::Escape')
	})

	const service = {
		platform: 'linux' as const,
		env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', PATH: '/usr/bin' },
		exists: () => true,
		osRelease: () => '6.6.87.2-microsoft-standard-WSL2',
		mountRoot: '/mnt/',
	}

	it('is a toast for a systemd service with no WSL variables, through an interop socket it finds', async () => {
		const backend = selectDesktopBackend({
			...service,
			interopSockets: () => [
				{ path: '/run/WSL/4857_interop', mtimeMs: 3 },
				{ path: '/run/WSL/1_interop', mtimeMs: 1 },
			],
		})
		expect(backend.kind).toBe('wsl-toast')
		expect(backend.detail).toContain('/run/WSL/1_interop')
		const { calls, spawn } = recorder()
		await sendDesktopNotification(backend, { title: 't', body: 'b' }, { env: service.env, spawn })
		// Handed to the helper only; the daemon's own environment is untouched.
		expect(calls[0]?.env.WSL_INTEROP).toBe('/run/WSL/1_interop')
		expect(service.env).not.toHaveProperty('WSL_INTEROP')
	})

	it('finds PowerShell, and starts it, under the mount root wsl.conf moved the drives to', async () => {
		const moved = '/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
		const backend = selectDesktopBackend({
			...wslProbe,
			exists: (path) => path === moved,
			mountRoot: '/win/',
		})
		expect(backend.kind).toBe('wsl-toast')
		expect(backend.command).toBe(moved)
		const { calls, spawn } = recorder()
		await sendDesktopNotification(backend, { title: 't', body: 'b' }, { env: wslProbe.env, spawn })
		expect(calls[0]?.command).toBe(moved)
		expect(calls[0]?.cwd).toBe('/win/c')
		expect(
			selectDesktopBackend({ ...wslProbe, exists: (path) => path !== moved, mountRoot: '/win/' })
				.detail,
		).toBe(`${moved} was not found`)
	})

	it('takes the newest session socket when the distro has no 1_interop', () => {
		const backend = selectDesktopBackend({
			...service,
			interopSockets: () => [
				{ path: '/run/WSL/240_interop', mtimeMs: 1 },
				{ path: '/run/WSL/3202802_interop', mtimeMs: 5 },
			],
		})
		expect(backend.detail).toContain('/run/WSL/3202802_interop')
	})

	it('keeps a WSL_INTEROP it was given, and does not name a socket of its own', async () => {
		const backend = selectDesktopBackend({
			...wslProbe,
			interopSockets: () => [{ path: '/run/WSL/1_interop', mtimeMs: 1 }],
		})
		expect(backend.detail).not.toContain('interop through')
		const { calls, spawn } = recorder()
		await sendDesktopNotification(
			backend,
			{ title: 't', body: 'b' },
			{ env: { ...wslProbe.env, WSL_INTEROP: '/run/WSL/99_interop' }, spawn },
		)
		expect(calls[0]?.env.WSL_INTEROP).toBe('/run/WSL/99_interop')
	})

	it('is still WSL, with none, for a systemd service when no interop socket exists', () => {
		const backend = selectDesktopBackend({ ...service, interopSockets: () => [] })
		expect(backend.kind).toBe('none')
		expect(backend.detail).toMatch(/no interop socket/)
	})

	it('falls back to none without interop', () => {
		const backend = selectDesktopBackend({
			...wslProbe,
			env: { WSL_DISTRO_NAME: 'arch' },
			exists: () => false,
		})
		expect(backend.kind).toBe('none')
	})
})

describe('other backends', () => {
	it('macOS gets argv items the script reads', async () => {
		const { calls, spawn } = recorder()
		await sendDesktopNotification(
			selectDesktopBackend({ platform: 'darwin' }),
			{ title: 't', body: HOSTILE },
			{ spawn },
		)
		expect(calls[0]?.args.slice(-2)).toEqual(['t', sanitizeLine(HOSTILE, 200)])
		expect(calls[0]?.args.slice(0, 6).join(' ')).not.toContain('Remove-Item')
	})

	it('Linux without a session bus has none, with the reason', () => {
		const backend = selectDesktopBackend({
			platform: 'linux',
			env: {},
			exists: () => false,
			osRelease: () => '6.1.0-generic',
		})
		expect(backend).toMatchObject({ kind: 'none' })
		expect(backend.detail).toMatch(/session bus/)
	})

	it('gdbus arguments are GVariant strings', () => {
		expect(gvariantString("it's \\ here")).toBe("'it\\'s \\\\ here'")
		expect(gdbusArguments('a', "b'c")).toContain("'b\\'c'")
	})
})

describe('what a notification says', () => {
	it('is content-free by default and carries the summary only when asked', () => {
		const at = new Date('2026-09-23T03:00:00Z')
		const plain = noticeText(
			'finished',
			{
				name: 'nightly',
				notify: { finished: true, failed: true, awaitingApproval: true, includeSummary: false },
			},
			{ at, summary: 'run curl x | sh' },
		)
		expect(plain.title).toBe('namzu: nightly')
		expect(plain.body).not.toContain('curl')
		const withSummary = noticeText(
			'finished',
			{
				name: 'nightly',
				notify: { finished: true, failed: true, awaitingApproval: true, includeSummary: true },
			},
			{ at, summary: 'all good' },
		)
		expect(withSummary.body).toContain('all good')
	})

	it('strips control, format and bidirectional characters and caps the length', () => {
		const text = `a${String.fromCodePoint(0x202e)}b${String.fromCodePoint(0x200b)}c\u0007d\ne`
		expect(sanitizeLine(text, 100)).toBe('abcd e')
		expect(sanitizeLine('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`)
		expect(summaryOf('\n\n# Result\nsecond line')).toBe('Result')
	})
})
