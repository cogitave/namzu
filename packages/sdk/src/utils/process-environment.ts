/**
 * Windows variables that let an ordinary child find executables, the command
 * interpreter, system DLLs, its profile and temporary storage.
 *
 * This is a fragment rather than a complete inheritance policy. MCP stdio and
 * LocalSandbox have different ambient grants; both need this fragment on the
 * Windows paths that already promise to launch a working process.
 */
export const WINDOWS_CORE_ENV_KEYS: readonly string[] = [
	'PATHEXT',
	'SystemRoot',
	'SystemDrive',
	'ComSpec',
	'WINDIR',
	'TEMP',
	'TMP',
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'APPDATA',
	'LOCALAPPDATA',
	'PROGRAMDATA',
	'PROGRAMFILES',
	'NUMBER_OF_PROCESSORS',
	'PROCESSOR_ARCHITECTURE',
]

type EnvironmentSource = Readonly<Record<string, string | undefined>>

function sameEnvironmentName(left: string, right: string, platform: NodeJS.Platform): boolean {
	return platform === 'win32' ? left.toUpperCase() === right.toUpperCase() : left === right
}

/** Read one environment entry using the host platform's key semantics. */
export function readEnvironmentEntry(
	source: EnvironmentSource,
	name: string,
	platform: NodeJS.Platform = process.platform,
): [name: string, value: string] | undefined {
	if (platform !== 'win32') {
		const value = source[name]
		return value === undefined ? undefined : [name, value]
	}

	// Enumerate rather than relying on process.env's Windows proxy so the key
	// handed to the child retains the spelling the parent actually used. Prefer
	// an exact spelling if an injected/plain object contains impossible twins.
	const entries = Object.entries(source).filter((entry): entry is [string, string] => {
		return entry[1] !== undefined
	})
	return (
		entries.find(([key]) => key === name) ??
		entries.find(([key]) => sameEnvironmentName(key, name, platform))
	)
}

/**
 * Set one entry, making a later override the sole spelling on Windows.
 *
 * JavaScript objects are case-sensitive; Windows environments are not. Without
 * removing the earlier spelling, `{ PATH, Path }` reaches Node's spawn layer
 * with two apparent winners and the configured precedence becomes accidental.
 */
export function setEnvironmentEntry(
	target: Record<string, string>,
	name: string,
	value: string,
	platform: NodeJS.Platform = process.platform,
): void {
	if (platform === 'win32') {
		for (const existing of Object.keys(target)) {
			if (sameEnvironmentName(existing, name, platform)) delete target[existing]
		}
	}
	target[name] = value
}

/** Copy only the named ambient entries. */
export function pickEnvironmentEntries(
	names: Iterable<string>,
	source: EnvironmentSource = process.env,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	const env: Record<string, string> = {}
	for (const name of names) {
		const found = readEnvironmentEntry(source, name, platform)
		if (found) setEnvironmentEntry(env, found[0], found[1], platform)
	}
	return env
}

/** Apply explicit entries in insertion order; later calls therefore win. */
export function applyEnvironmentOverrides(
	target: Record<string, string>,
	overrides: EnvironmentSource | undefined,
	platform: NodeJS.Platform = process.platform,
): void {
	for (const [name, value] of Object.entries(overrides ?? {})) {
		if (value !== undefined) setEnvironmentEntry(target, name, value, platform)
	}
}
