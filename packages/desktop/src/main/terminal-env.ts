import { constants, accessSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, posix, win32 } from 'node:path'
import {
	type EngineHost,
	type ShellEnvironment,
	findWindowsProgram,
} from '../shared/terminal-tabs.js'

type Env = Record<string, string | undefined>

export interface TerminalEnvDeps {
	platform: NodeJS.Platform
	env: Env
	home: string
	/** Whether something is there, of any kind: an app-execution alias is a reparse point. */
	exists: (path: string) => boolean
	/** Whether a file can be run. */
	executable: (path: string) => boolean
}

export function defaultTerminalEnvDeps(): TerminalEnvDeps {
	return {
		platform: process.platform,
		env: process.env,
		home: homedir(),
		exists: (path) => {
			try {
				lstatSync(path)
				return true
			} catch {
				return false
			}
		},
		executable: (path) => {
			try {
				accessSync(path, constants.X_OK)
				return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
			} catch {
				return false
			}
		},
	}
}

function pathOf(env: Env): string {
	return env.PATH ?? env.Path ?? ''
}

/** Where a program is, over PATH and the places each system keeps the shells. */
export function shellEnvironment(
	deps: TerminalEnvDeps = defaultTerminalEnvDeps(),
): ShellEnvironment {
	const windows = deps.platform === 'win32'
	const join = windows ? win32.join : posix.join
	const root = deps.env.SystemRoot ?? deps.env.windir ?? 'C:\\Windows'
	const programFiles = deps.env.ProgramFiles ?? 'C:\\Program Files'
	const known: Record<string, string[]> = {
		'pwsh.exe': [join(programFiles, 'PowerShell', '7', 'pwsh.exe')],
		'powershell.exe': [join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
		'wsl.exe': [join(root, 'System32', 'wsl.exe')],
		'cmd.exe': [join(root, 'System32', 'cmd.exe')],
	}
	return {
		platform: deps.platform,
		env: deps.env,
		find: (name) => {
			if (!windows) return undefined
			for (const directory of pathOf(deps.env).split(';').filter(Boolean)) {
				const candidate = `${directory.replace(/[\\/]+$/u, '')}\\${name}`
				if (deps.exists(candidate)) return candidate
			}
			return known[name]?.find((candidate) => deps.exists(candidate))
		},
	}
}

function root(deps: TerminalEnvDeps): string {
	return deps.env.SystemRoot ?? deps.env.windir ?? 'C:\\Windows'
}

/** The directories a person's own tools land in that a launcher's PATH often lacks. */
function toolDirectories(deps: TerminalEnvDeps): string[] {
	const join = deps.platform === 'win32' ? win32.join : posix.join
	if (deps.platform === 'win32')
		return [
			join(deps.home, '.local', 'bin'),
			...(deps.env.APPDATA ? [join(deps.env.APPDATA, 'npm')] : []),
		]
	return [
		join(deps.home, '.local', 'bin'),
		join(deps.home, '.npm-global', 'bin'),
		'/usr/local/bin',
		'/opt/homebrew/bin',
	]
}

/**
 * How the Desktop starts an engine's CLI. `cliEntry` is the bundled CLI that the Namzu engine runs
 * as Node under Electron; `nodeArgs` are the Node flags that must precede it.
 */
export function engineHost(
	input: { execPath: string; cliEntry?: string; nodeArgs: string[] },
	deps: TerminalEnvDeps = defaultTerminalEnvDeps(),
): EngineHost {
	return {
		platform: deps.platform,
		execPath: input.execPath,
		...(input.cliEntry ? { cliEntry: input.cliEntry } : {}),
		nodeArgs: input.nodeArgs,
		...(deps.platform === 'win32'
			? { commandPrompt: deps.env.ComSpec || win32.join(root(deps), 'System32', 'cmd.exe') }
			: {}),
		resolve: (name) => findProgram(name, deps),
	}
}

/**
 * Where a program is over PATH and the places a person's own tools land. A name may be a program
 * Namzu only reads the version of or updates through (`npm`), not just an engine.
 */
export function findProgram(
	name: string,
	deps: TerminalEnvDeps = defaultTerminalEnvDeps(),
): { path: string; shim: boolean } | undefined {
	if (deps.platform === 'win32')
		return findWindowsProgram(name, {
			path: pathOf(deps.env),
			extensions: ['.exe', '.cmd'],
			extraDirectories: [
				...toolDirectories(deps),
				...(deps.env.ProgramFiles ? [win32.join(deps.env.ProgramFiles, 'nodejs')] : []),
			],
			exists: deps.exists,
		})
	for (const directory of [
		...pathOf(deps.env).split(delimiter).filter(Boolean),
		...toolDirectories(deps),
	]) {
		const candidate = posix.join(directory, name)
		if (deps.executable(candidate)) return { path: candidate, shim: false }
	}
	return undefined
}
