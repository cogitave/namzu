/**
 * WSL: the daemon runs inside the distro, supervised by Windows Task
 * Scheduler through `wsl.exe`.
 *
 * A distro is not running after Windows logs on until something starts it,
 * and a systemd unit inside the distro cannot start its own distro; the
 * `wsl.exe` process the task holds open both starts it and keeps WSL's idle
 * shutdown away. The Windows programs are resolved once, here, from their
 * fixed locations — never through PATH, whose `/mnt` entries make a failed
 * lookup cost seconds — and recorded in the manifest.
 *
 * Refused at install: interop that does not answer, a node or CLI whose path
 * `wsl.exe` would re-parse into something else, and a CLI running from the
 * npx cache (it disappears).
 */

import { existsSync } from 'node:fs'
import { checkWslPath } from './quote.js'
import type { CommandRunner } from './runner.js'
import { type TaskDefinition, taskPath } from './windows-task.js'

export interface WindowsTools {
	readonly systemRoot: string
	readonly cmd: string
	readonly schtasks: string
	readonly powershell: string
	readonly whoami: string
	readonly conhost: string
	readonly wsl: string
}

export const DEFAULT_SYSTEM32 = '/mnt/c/Windows/System32'

export function windowsTools(system32 = DEFAULT_SYSTEM32): WindowsTools {
	return {
		systemRoot: system32.replace(/\/System32$/i, ''),
		cmd: `${system32}/cmd.exe`,
		schtasks: `${system32}/schtasks.exe`,
		powershell: `${system32}/WindowsPowerShell/v1.0/powershell.exe`,
		whoami: `${system32}/whoami.exe`,
		conhost: `${system32}/conhost.exe`,
		wsl: `${system32}/wsl.exe`,
	}
}

/** Interop answers: a Windows program starts and exits 0. */
export async function probeInterop(
	run: CommandRunner,
	tools: WindowsTools,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (!existsSync(tools.cmd))
		return { ok: false, reason: `${tools.cmd} was not found (is C: mounted at /mnt/c?)` }
	if (!env.WSL_INTEROP && !existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
		return {
			ok: false,
			reason: 'WSL interop is disabled ([interop] enabled=false in /etc/wsl.conf)',
		}
	}
	const result = await run(tools.cmd, ['/d', '/c', 'ver'], { timeoutMs: 20_000, cwd: '/mnt/c' })
	return result.code === 0
		? { ok: true }
		: {
				ok: false,
				reason: `a Windows program did not start through interop (${result.stderr.trim() || `exit ${result.code}`})`,
			}
}

/** `DOMAIN\user` of the Windows account, from `whoami.exe`. */
export async function windowsUser(run: CommandRunner, tools: WindowsTools): Promise<string> {
	const result = await run(tools.whoami, [], { timeoutMs: 20_000, cwd: '/mnt/c' })
	const user = result.stdout.trim()
	if (result.code !== 0 || !/^[^\\\s]+\\[^\\\s]+$/.test(user)) {
		throw new Error(
			`could not read the Windows user from whoami.exe (${result.stderr.trim() || user || `exit ${result.code}`})`,
		)
	}
	return user
}

/** A Linux path as Windows sees it, through `wslpath -w`. */
export async function toWindowsPath(run: CommandRunner, path: string): Promise<string> {
	const result = await run('wslpath', ['-w', path], { timeoutMs: 10_000 })
	if (result.code !== 0 || !result.stdout.trim()) throw new Error(`wslpath -w ${path} failed`)
	return result.stdout.trim()
}

/** Whether a CLI path is inside the npx cache, which is not kept. */
export function isEphemeralBin(bin: string): boolean {
	return /[\\/]_npx[\\/]/.test(bin) || /[\\/]\.npm[\\/]_cacache[\\/]/.test(bin)
}

export function wslTaskName(name: string, distro: string): string {
	return `${name}-wsl-${distro.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

/**
 * The task that runs the daemon in the distro. `conhost.exe --headless` keeps
 * a console window from appearing at logon.
 */
export function wslTaskDefinition(options: {
	readonly userId: string
	readonly distro: string
	readonly linuxUser: string
	readonly node: string
	readonly bin: string
	readonly namzuHome: string
	readonly systemRoot?: string
}): TaskDefinition {
	checkWslPath('node', options.node)
	checkWslPath('the namzu CLI', options.bin)
	checkWslPath('NAMZU_HOME', options.namzuHome)
	if (!/^[A-Za-z0-9._-]+$/.test(options.distro))
		throw new Error(`unusual WSL distro name: ${options.distro}`)
	if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(options.linuxUser))
		throw new Error(`unusual Linux user name: ${options.linuxUser}`)
	const root = options.systemRoot ?? 'C:\\Windows'
	return {
		userId: options.userId,
		description: `namzu scheduler for NAMZU_HOME=${options.namzuHome} in WSL ${options.distro}`,
		command: `${root}\\System32\\conhost.exe`,
		args: [
			'--headless',
			`${root}\\System32\\wsl.exe`,
			'-d',
			options.distro,
			'-u',
			options.linuxUser,
			'--cd',
			'/',
			'--exec',
			'/usr/bin/env',
			`NAMZU_HOME=${options.namzuHome}`,
			options.node,
			options.bin,
			'schedule',
			'daemon',
			'--home',
			options.namzuHome,
		],
	}
}

export { taskPath }
