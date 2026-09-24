/**
 * Hand a URL to whatever the machine opens URLs with, or say it could not.
 *
 * ## No shell, ever
 *
 * The URL this receives carries operator-visible parameters and is built from
 * a template, so the tempting Windows spelling — `cmd /c start <url>` — is the
 * one to avoid on principle rather than after an incident: `cmd.exe` re-parses
 * `&`, `|`, `^` and friends BEFORE `start` sees them, which makes any URL a
 * command line. `rundll32 url.dll,FileProtocolHandler` takes the address as an
 * argument and nothing re-reads it, and the launcher is invoked by absolute
 * path under the system directory so a same-named executable earlier on `PATH`
 * cannot answer instead.
 *
 * ## WSL: the Windows browser
 *
 * Under WSL the desktop the user looks at is Windows', and `xdg-open` reaches
 * a Linux browser at best (usually nothing). With interop on, the address goes
 * to Windows' own protocol handler through `powershell.exe`, named by absolute
 * path, running a CONSTANT script (`Start-Process -FilePath
 * $env:NAMZU_OPEN_URL`) sent as `-EncodedCommand`: the address reaches it only
 * as an environment variable named in `WSLENV`, so nothing parses it as code
 * — the same shape as the WSL toast in `notifications/desktop/windows-toast.ts`.
 * This is what the `open` package does on WSL too, minus its six dependencies
 * and its quoting of the address into the script text. `cmd.exe /c start` is
 * not used, for the reason above; `explorer.exe` is not used because it exits
 * 1 even when it opened the page.
 *
 * ## Best effort, reported honestly
 *
 * Returns whether a launcher was even STARTED, not whether a browser appeared
 * — nothing on any platform tells us that. A caller must therefore print the
 * URL regardless: `true` means "a browser is probably opening", never "you can
 * stop reading". On a machine with no graphical session there is nothing to
 * start and this says so, which is the case the paste path exists for.
 */

import { spawn } from 'node:child_process'
import { constants, accessSync, existsSync } from 'node:fs'
import { platform } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

import { detectWsl } from '../context/environment.js'

/** Resolve a launcher before claiming that one started. */
function executableOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
	for (const directory of (env.PATH ?? '').split(delimiter)) {
		// An empty or relative PATH member delegates executable authority to the
		// project cwd. Opening an OAuth URL must never run a project-owned helper.
		if (!directory || !isAbsolute(directory)) continue
		const candidate = join(directory, name)
		try {
			accessSync(candidate, constants.X_OK)
			return candidate
		} catch {
			// Keep looking. PATH order remains the operator's host policy.
		}
	}
	return null
}

/** Where Windows keeps PowerShell, as WSL mounts it by default. */
export const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/** The whole WSL script. The address is data in the environment, never text here. */
export const WSL_OPEN_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	'Start-Process -FilePath $env:NAMZU_OPEN_URL',
].join('\n')

/** The machine, injectable so a test can describe one it is not running on. */
export interface BrowserHost {
	readonly platform?: NodeJS.Platform
	readonly env?: NodeJS.ProcessEnv
	readonly exists?: (path: string) => boolean
}

interface Launch {
	readonly command: string
	readonly args: readonly string[]
	readonly env?: NodeJS.ProcessEnv
	readonly cwd?: string
}

/** Windows' protocol handler through interop, or `null` when this is not a WSL that can reach it. */
function wslLaunch(
	url: string,
	env: NodeJS.ProcessEnv,
	exists: (path: string) => boolean,
): Launch | null {
	const wsl = detectWsl(env, { exists, list: () => [] })
	if (!wsl?.interop || !exists(WSL_POWERSHELL)) return null
	const passed = (env.WSLENV ?? '')
		.split(':')
		.filter((name) => name && !name.startsWith('NAMZU_OPEN_URL'))
	return {
		command: WSL_POWERSHELL,
		args: [
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
			Buffer.from(WSL_OPEN_SCRIPT, 'utf16le').toString('base64'),
		],
		env: { ...env, NAMZU_OPEN_URL: url, WSLENV: [...passed, 'NAMZU_OPEN_URL'].join(':') },
		// A Windows program started from a Linux directory warns about UNC
		// paths; the drive PowerShell lives on is a Windows directory.
		cwd: '/mnt/c',
	}
}

function launchFor(url: string, host: BrowserHost): Launch | null {
	const currentPlatform = host.platform ?? platform()
	const env = host.env ?? process.env
	if (currentPlatform === 'win32') {
		return {
			command: join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'),
			args: ['url.dll,FileProtocolHandler', url],
		}
	}
	if (currentPlatform === 'linux') {
		const wsl = wslLaunch(url, env, host.exists ?? existsSync)
		if (wsl) return wsl
	}
	const command = executableOnPath(currentPlatform === 'darwin' ? 'open' : 'xdg-open', env)
	return command ? { command, args: [url] } : null
}

export function openInBrowser(url: string, host: BrowserHost = {}): boolean {
	// Refuse anything that is not a web address. This is handed to the
	// machine's protocol handler, and `file:` or a custom scheme reaching it
	// would be this function opening something nobody named.
	if (!/^https?:\/\//i.test(url)) return false

	const launch = launchFor(url, host)
	if (!launch) return false

	try {
		const child = spawn(launch.command, [...launch.args], {
			stdio: 'ignore',
			detached: true,
			...(launch.env ? { env: launch.env } : {}),
			...(launch.cwd ? { cwd: launch.cwd } : {}),
		})
		// A missing launcher — no `xdg-open` in a container — arrives as an
		// async error event, long after this function returned. Swallowing it
		// keeps a headless machine from taking the process down over a browser
		// nobody was going to see; the caller already printed the URL.
		child.on('error', () => {})
		child.unref()
		return true
	} catch {
		return false
	}
}
