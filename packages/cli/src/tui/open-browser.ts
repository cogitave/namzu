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
 * ## Best effort, reported honestly
 *
 * Returns whether a launcher was even STARTED, not whether a browser appeared
 * — nothing on any platform tells us that. A caller must therefore print the
 * URL regardless: `true` means "a browser is probably opening", never "you can
 * stop reading". On a machine with no graphical session there is nothing to
 * start and this says so, which is the case the paste path exists for.
 */

import { spawn } from 'node:child_process'
import { constants, accessSync } from 'node:fs'
import { platform } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Resolve a launcher before claiming that one started. */
function executableOnPath(name: string): string | null {
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
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

export function openInBrowser(url: string): boolean {
	// Refuse anything that is not a web address. This is handed to the
	// machine's protocol handler, and `file:` or a custom scheme reaching it
	// would be this function opening something nobody named.
	if (!/^https?:\/\//i.test(url)) return false

	const currentPlatform = platform()
	const command =
		currentPlatform === 'win32'
			? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe')
			: executableOnPath(currentPlatform === 'darwin' ? 'open' : 'xdg-open')
	if (!command) return false
	const args = currentPlatform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]

	try {
		const child = spawn(command, args, {
			stdio: 'ignore',
			detached: true,
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
