/**
 * Desktop notifications for scheduled runs.
 *
 * | Backend | When | How |
 * |---|---|---|
 * | `wsl-toast` | WSL with interop and `powershell.exe` | a Windows toast through interop |
 * | `windows-toast` | Windows | the same toast |
 * | `macos` | macOS | `osascript`, title and body as argv |
 * | `freedesktop` | Linux with a session bus | `notify-send`, else `gdbus` |
 * | `none` | nothing works | the reason is kept and shown by `schedule status` |
 *
 * Title and body are DATA: they reach the other program as argv items or
 * environment variables, never as script text, and are stripped of control,
 * format and bidirectional characters first. By default a notification says
 * which job and what happened, nothing from the model; a job opts into its
 * one-line summary with `notify.includeSummary`.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectWsl } from '../../context/environment.js'
import { gdbusArguments, notifySendArguments } from './desktop/freedesktop.js'
import { osascriptArguments } from './desktop/macos.js'
import { sanitizeLine } from './desktop/sanitize.js'
import { toastArguments, toastEnvironment } from './desktop/windows-toast.js'

export type DesktopBackendKind = 'wsl-toast' | 'windows-toast' | 'macos' | 'freedesktop' | 'none'

export interface DesktopBackend {
	readonly kind: DesktopBackendKind
	/** Why `none`, or which program the backend runs. */
	readonly detail: string
	readonly command?: string
	readonly args?: (title: string, body: string) => string[]
	readonly env?: (base: NodeJS.ProcessEnv, title: string, body: string) => NodeJS.ProcessEnv
	readonly cwd?: string
}

export interface BackendProbe {
	readonly platform?: NodeJS.Platform
	readonly env?: NodeJS.ProcessEnv
	readonly exists?: (path: string) => boolean
	/** A program on PATH, by name. */
	readonly which?: (name: string) => string | undefined
	/** `powershell.exe` under WSL, as recorded at install. */
	readonly powershell?: string
	/** The kernel release (`/proc/sys/kernel/osrelease`); WSL's names Microsoft. */
	readonly osRelease?: () => string | undefined
}

function readOsRelease(): string | undefined {
	try {
		return readFileSync('/proc/sys/kernel/osrelease', 'utf8')
	} catch {
		return undefined
	}
}

function whichOnPath(env: NodeJS.ProcessEnv, exists: (p: string) => boolean) {
	return (name: string): string | undefined => {
		for (const dir of (env.PATH ?? '').split(':')) {
			// Never search Windows drives: a lookup there costs seconds under WSL.
			if (!dir || dir.startsWith('/mnt/')) continue
			const candidate = join(dir, name)
			if (exists(candidate)) return candidate
		}
		return undefined
	}
}

const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/** Pick the backend this machine supports. */
export function selectDesktopBackend(probe: BackendProbe = {}): DesktopBackend {
	const platform = probe.platform ?? process.platform
	const env = probe.env ?? process.env
	const exists = probe.exists ?? existsSync
	const which = probe.which ?? whichOnPath(env, exists)
	if (platform === 'darwin') {
		return {
			kind: 'macos',
			detail: 'osascript',
			command: '/usr/bin/osascript',
			args: osascriptArguments,
		}
	}
	if (platform === 'win32') {
		return {
			kind: 'windows-toast',
			detail: 'powershell.exe',
			command: 'powershell.exe',
			args: () => toastArguments(),
			env: (base, title, body) => toastEnvironment(base, title, body, false),
		}
	}
	const wsl = detectWsl(env, { exists })
	// A systemd user service in WSL gets neither WSL_DISTRO_NAME nor
	// WSL_INTEROP, so the environment alone does not say this is WSL; the
	// kernel does. Without this, such a daemon picked the Linux session bus,
	// which nothing in WSL displays, and every notification failed.
	const wslKernel = !wsl && /microsoft/i.test((probe.osRelease ?? readOsRelease)() ?? '')
	if (wsl || wslKernel) {
		if (!wsl?.interop || !env.WSL_INTEROP) {
			return {
				kind: 'none',
				detail:
					'WSL interop is not available to this process (no WSL_INTEROP; a systemd service has none), so Windows notifications cannot be shown',
			}
		}
		const powershell = probe.powershell ?? WSL_POWERSHELL
		if (!exists(powershell)) return { kind: 'none', detail: `${powershell} was not found` }
		return {
			kind: 'wsl-toast',
			detail: powershell,
			command: powershell,
			args: () => toastArguments(),
			env: (base, title, body) => toastEnvironment(base, title, body, true),
			cwd: '/mnt/c',
		}
	}
	const bus =
		env.DBUS_SESSION_BUS_ADDRESS ||
		(env.XDG_RUNTIME_DIR && exists(join(env.XDG_RUNTIME_DIR, 'bus')) ? 'runtime-bus' : '')
	if (!bus)
		return { kind: 'none', detail: 'no desktop session bus (DBUS_SESSION_BUS_ADDRESS is unset)' }
	const notifySend = which('notify-send')
	if (notifySend)
		return {
			kind: 'freedesktop',
			detail: notifySend,
			command: notifySend,
			args: notifySendArguments,
		}
	const gdbus = which('gdbus')
	if (gdbus) return { kind: 'freedesktop', detail: gdbus, command: gdbus, args: gdbusArguments }
	return { kind: 'none', detail: 'neither notify-send nor gdbus is installed' }
}

export interface DesktopNotification {
	readonly title: string
	readonly body: string
}

export type DesktopNotifyResult =
	| { readonly kind: 'sent' }
	| { readonly kind: 'unavailable'; readonly detail: string }
	| { readonly kind: 'failed'; readonly detail: string }

export type Spawn = (
	command: string,
	args: readonly string[],
	options: { readonly env: NodeJS.ProcessEnv; readonly cwd?: string; readonly timeoutMs: number },
) => Promise<{ readonly code: number | null; readonly stderr: string }>

const defaultSpawn: Spawn = (command, args, options) =>
	new Promise((resolve) => {
		execFile(
			command,
			[...args],
			{
				env: options.env,
				...(options.cwd ? { cwd: options.cwd } : {}),
				timeout: options.timeoutMs,
				windowsHide: true,
			},
			(error, _stdout, stderr) => {
				const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
				resolve({ code, stderr: String(stderr ?? '').slice(0, 500) })
			},
		)
	})

/** Send one notification. Never throws. */
export async function sendDesktopNotification(
	backend: DesktopBackend,
	notification: DesktopNotification,
	options: { readonly env?: NodeJS.ProcessEnv; readonly spawn?: Spawn } = {},
): Promise<DesktopNotifyResult> {
	if (backend.kind === 'none' || !backend.command || !backend.args) {
		return { kind: 'unavailable', detail: backend.detail }
	}
	const title = sanitizeLine(notification.title, 64)
	const body = sanitizeLine(notification.body, 200)
	const base = options.env ?? process.env
	const env = backend.env ? backend.env(base, title, body) : base
	try {
		const result = await (options.spawn ?? defaultSpawn)(
			backend.command,
			backend.args(title, body),
			{
				env,
				...(backend.cwd ? { cwd: backend.cwd } : {}),
				timeoutMs: 15_000,
			},
		)
		return result.code === 0
			? { kind: 'sent' }
			: { kind: 'failed', detail: result.stderr || `exit ${String(result.code)}` }
	} catch (error) {
		return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
	}
}
