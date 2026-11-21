/**
 * The Windows-side Namzu store, reached from a terminal that runs inside WSL.
 *
 * ## The problem this answers
 *
 * Namzu Desktop on Windows keeps its sign-ins in `%USERPROFILE%\.namzu\credentials.json`.
 * A terminal inside WSL keeps its own in `/home/<user>/.namzu/credentials.json`. They are
 * two homes on one machine, so a sign-in made in one was invisible to the other.
 *
 * ## One source of truth
 *
 * The terminal never copies the Windows credential. A subscription refresh token rotates, so
 * a copy would be dead the first time either side refreshed. Instead the terminal READS the
 * Windows store in place, and a refresh is written back to that same file under the same
 * lock protocol the Windows side uses (`credentials.json.lock`, then a rename). There is
 * still exactly one credential record per sign-in.
 *
 * The rule is "own first": a credential in the terminal's own home always wins. The Windows
 * store is consulted only for a provider the terminal's own file does not hold, so a person
 * who signs in on the terminal keeps that sign-in, and two different accounts on the two
 * sides never get mixed (the terminal uses its own, and says so).
 *
 * ## When it applies
 *
 * Only when all of these hold; any other answer is "no second store":
 *  - Linux with WSL interop (the same gate the Claude-session lookup uses);
 *  - the default home is in use (`NAMZU_HOME` unset, no explicit home argument);
 *  - sharing is not turned off (`shareDesktopSignIn: false`, or `NAMZU_SHARE_DESKTOP_SIGNIN=0`);
 *  - the Windows account's home resolves through the documented route
 *    (`cmd.exe /c echo %USERPROFILE%`, see `wslWindowsHome`), never by guessing a user name;
 *  - `.namzu/credentials.json` there is a regular file, not a link.
 *
 * Windows file permissions are not checked from here: the mounted drive reports every file
 * as mode 0777, so a POSIX owner-only assertion could only ever fail. The protection is the
 * Windows profile's own access list, which the Windows side proved when it wrote the file.
 */

import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { readSwitch } from '../auto-update/policy.js'
import { wslWindowsHome } from './harness-credentials.js'

export const DESKTOP_SIGN_IN_ENV = 'NAMZU_SHARE_DESKTOP_SIGNIN'

/** How long a failed lookup of the Windows home is remembered before it is asked again. */
const FAILED_LOOKUP_MS = 60_000

let configured = true
let locator: (() => string | null) | undefined
let remembered: { readonly at: number; readonly path: string | null } | undefined

/**
 * The `shareDesktopSignIn` setting, set once when the configuration is resolved. The
 * environment variable still wins, so a CI job or a shell can turn sharing off without a file.
 */
export function configureDesktopSignInSharing(enabled: boolean | undefined): void {
	configured = enabled !== false
	remembered = undefined
}

/** Test seam: answer "where is the Windows home" without starting a Windows process. */
export function setWindowsHomeLocator(next: (() => string | null) | undefined): void {
	locator = next
	remembered = undefined
}

export function desktopSignInSharingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return readSwitch(env[DESKTOP_SIGN_IN_ENV]) ?? configured
}

/**
 * The Windows store's `credentials.json`, or null when sharing does not apply here or the
 * file is not an ordinary file. Never throws.
 */
export function desktopCredentialsPath(env: NodeJS.ProcessEnv = process.env): string | null {
	if (env.NAMZU_HOME?.trim()) return null
	if (!desktopSignInSharingEnabled(env)) return null
	if (locator === undefined && process.platform !== 'linux') return null
	const now = Date.now()
	if (remembered && (remembered.path !== null || now - remembered.at < FAILED_LOOKUP_MS)) {
		return remembered.path !== null && isPlainFile(remembered.path) ? remembered.path : null
	}
	let home: string | null = null
	try {
		home = locator ? locator() : wslWindowsHome(env)
	} catch {
		home = null
	}
	const path = home === null ? null : join(home, '.namzu', 'credentials.json')
	remembered = { at: now, path }
	return path !== null && isPlainFile(path) ? path : null
}

/**
 * An ordinary file in an ordinary `.namzu` directory that really lives under the Windows
 * home. A link or junction at either level could lead a read, a lock or a rename out of the
 * profile, so both are refused, and the resolved path must stay inside the resolved home.
 */
function isPlainFile(path: string): boolean {
	try {
		const dir = dirname(path)
		const dirEntry = lstatSync(dir)
		if (!dirEntry.isDirectory() || dirEntry.isSymbolicLink()) return false
		const entry = lstatSync(path)
		if (!entry.isFile() || entry.isSymbolicLink()) return false
		const home = realpathSync(dirname(dir))
		return realpathSync(path).startsWith(home + sep)
	} catch {
		return false
	}
}
