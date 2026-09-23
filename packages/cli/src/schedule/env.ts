/**
 * The environment a scheduled run starts with.
 *
 * A service does not see what an interactive shell exported, so the daemon
 * builds each child's environment from an allowlist rather than passing its
 * own along; `daemon.env` (0600, `KEY=value` lines) supplies credentials. Its
 * values reach PROVIDER DISCOVERY only — the fire child reads the file itself
 * and hands the variables to discovery as an object, never into `process.env`,
 * where the bash tool would inherit whatever name a credential happened to
 * have.
 */

import { readFileSync, statSync } from 'node:fs'

/** Variables a child inherits from the daemon. Nothing else. */
export const CHILD_ENV_ALLOWLIST = [
	'HOME',
	'USER',
	'LOGNAME',
	'LANG',
	'LC_ALL',
	'TZ',
	'TMPDIR',
	'SHELL',
	'XDG_RUNTIME_DIR',
	'XDG_CONFIG_HOME',
	'DBUS_SESSION_BUS_ADDRESS',
	'WSL_DISTRO_NAME',
	'WSL_INTEROP',
	'SystemRoot',
	'USERPROFILE',
	'APPDATA',
	'LOCALAPPDATA',
] as const

/** `PATH` without Windows drive mounts: under WSL a failed lookup through `/mnt/c` costs seconds. */
export function stripWindowsMounts(path: string | undefined): string {
	return (path ?? '')
		.split(':')
		.filter((entry) => entry !== '' && !/^\/mnt\/[a-z](\/|$)/i.test(entry))
		.join(':')
}

/** The environment of a fire child. */
export function childEnvironment(source: NodeJS.ProcessEnv, namzuHome: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {}
	for (const key of CHILD_ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key]
	env.PATH =
		process.platform === 'win32'
			? (source.PATH ?? source.Path ?? '')
			: stripWindowsMounts(source.PATH)
	if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin'
	env.NAMZU_HOME = namzuHome
	return env
}

export interface DaemonEnvFile {
	readonly values: Readonly<Record<string, string>>
	readonly warnings: readonly string[]
}

/**
 * Read `daemon.env`: `KEY=value` per line, `#` comments, optional matching
 * quotes around a value. A file others can read is reported, not refused:
 * refusing would stop every job over a mode bit.
 */
export function readDaemonEnv(path: string): DaemonEnvFile {
	let text: string
	try {
		text = readFileSync(path, 'utf8')
	} catch {
		return { values: {}, warnings: [] }
	}
	const warnings: string[] = []
	try {
		const mode = statSync(path).mode & 0o077
		if (mode !== 0 && process.platform !== 'win32') {
			warnings.push(`${path} can be read by other users; run chmod 600 on it`)
		}
	} catch {}
	const values: Record<string, string> = {}
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = raw.trim()
		if (!line || line.startsWith('#')) return
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
		if (!match) {
			warnings.push(`${path}:${index + 1} is not KEY=value; ignored`)
			return
		}
		let value = match[2] ?? ''
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
			value = value.slice(1, -1)
		}
		values[match[1] as string] = value
	})
	return { values, warnings }
}
