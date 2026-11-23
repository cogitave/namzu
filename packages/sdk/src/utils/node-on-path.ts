import { constants, accessSync, realpathSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { readEnvironmentEntry, setEnvironmentEntry } from './process-environment.js'

export interface NodeOnPathOptions {
	/** The running binary. Defaults to `process.execPath`. */
	readonly execPath?: string
	readonly platform?: NodeJS.Platform
	/** Whether a file is an executable `node`. Defaults to a filesystem check. */
	readonly isExecutable?: (file: string) => boolean
	/** Resolve links. Defaults to `fs.realpathSync`. */
	readonly realpath?: (file: string) => string
}

function defaultIsExecutable(file: string, platform: NodeJS.Platform): boolean {
	try {
		if (!statSync(file).isFile()) return false
		if (platform !== 'win32') accessSync(file, constants.X_OK)
		return true
	} catch {
		return false
	}
}

/**
 * The directory that would be appended to PATH so `node` resolves, or
 * undefined when `node` already resolves (or cannot be offered).
 */
export function nodeDirectoryToAppend(
	pathValue: string,
	options: NodeOnPathOptions = {},
): string | undefined {
	const platform = options.platform ?? process.platform
	const path = platform === 'win32' ? win32 : posix
	const execPath = options.execPath ?? process.execPath
	const binary = path.basename(execPath).toLowerCase()
	const wanted = platform === 'win32' ? ['node.exe', 'node.cmd'] : ['node']
	if (!wanted.includes(binary)) return undefined

	const entries = pathValue.split(path.delimiter)
	const isExecutable =
		options.isExecutable ?? ((file: string) => defaultIsExecutable(file, platform))
	for (const dir of entries) {
		if (dir === '') continue
		for (const file of wanted) if (isExecutable(path.join(dir, file))) return undefined
	}

	let target: string
	try {
		target = path.dirname((options.realpath ?? realpathSync)(execPath))
	} catch {
		target = path.dirname(execPath)
	}
	return entries.includes(target) ? undefined : target
}

/**
 * Make `node` resolvable in a shell command's environment.
 *
 * The runtime is often started by an absolute path whose directory is not on
 * the user's PATH, so a command like `node --test` then fails with exit 127
 * while the runtime itself is running on that very binary. When no `node`
 * resolves on PATH, the directory of the running binary is appended to the END
 * of PATH: a `node` the user has installed always wins. The environment is
 * returned unchanged when `node` already resolves, when PATH is absent, or when
 * the running binary is not a plain node binary (an embedded runtime).
 */
export function withNodeOnPath(
	env: Record<string, string>,
	options: NodeOnPathOptions = {},
): Record<string, string> {
	const platform = options.platform ?? process.platform
	const entry = readEnvironmentEntry(env, 'PATH', platform)
	if (!entry) return env
	const [name, value] = entry
	const target = nodeDirectoryToAppend(value, options)
	if (target === undefined) return env
	const separator = platform === 'win32' ? ';' : ':'
	setEnvironmentEntry(env, name, value === '' ? target : `${value}${separator}${target}`, platform)
	return env
}
