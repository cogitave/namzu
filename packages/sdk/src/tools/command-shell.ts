/**
 * Which shell runs a `bash` tool command, and in what dialect it must be read.
 *
 * ## Why this is one decision
 *
 * The permission rules read a command line before it runs
 * (`authorization/shell-lexer.ts`), and a reading is only as good as its
 * match with the shell that runs the line afterwards. The tool is called
 * `bash` and its description says bash, but it used to spawn `/bin/sh -c`:
 * bash on some hosts, `dash` on Debian and Ubuntu, `busybox sh` in small
 * images. `$'\x3b'`, `|&`, `&>` and `<<<` mean different things in those,
 * so a line the rules read as bash could run as something else.
 *
 * So the host path now runs bash wherever bash exists, and the reading
 * follows what was actually chosen:
 *
 * - bash found (or named by `NAMZU_BASH_SHELL`) → `bash -c`, read in the
 *   `bash` dialect;
 * - no bash → `/bin/sh -c`, read in the conservative `sh` dialect, in which
 *   every construct whose meaning differs between bash and a POSIX shell
 *   makes a line opaque;
 * - inside a sandbox the guest image decides, and the rules cannot see it,
 *   so a small launcher runs bash when the guest has it and `/bin/sh`
 *   otherwise, and the line is always read in the `sh` dialect, which is
 *   right for either.
 *
 * ## Equivalent to what ran before
 *
 * `/bin/sh -c` read no startup file. `bash -c` reads none either, except
 * the file `BASH_ENV` names, and it imports shell functions (`BASH_FUNC_*`)
 * and parser options (`SHELLOPTS`, `BASHOPTS`) from its environment. Any of
 * those would change what a command line means after the rules read it, so
 * they are removed from the environment of the spawned bash.
 * `NAMZU_BASH_SHELL=/bin/sh` restores the old shell exactly.
 */

import { constants, accessSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import type { ShellDialect } from '../types/tool/index.js'

/** The shell a host-side command runs in. */
export interface CommandShell {
	/** The executable, run as `<path> -c <command>`. Undefined: Node's platform shell (Windows). */
	readonly path: string | undefined
	/** How the permission rules read a line this shell runs. */
	readonly dialect: ShellDialect
	/** Where the choice came from, for diagnostics. */
	readonly source: 'override' | 'bash' | 'sh' | 'platform'
}

/** What resolution looks at. Injected by tests to simulate a host without bash. */
export interface CommandShellProbe {
	readonly env: NodeJS.ProcessEnv
	readonly platform: NodeJS.Platform
	readonly isExecutable: (path: string) => boolean
}

const WELL_KNOWN_BASH = ['/bin/bash', '/usr/bin/bash']

/** Environment variables that change what a bash command line means. */
const BASH_STARTUP_VARIABLES = new Set(['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS'])

export function findCommandShell(probe: CommandShellProbe): CommandShell {
	const override = probe.env.NAMZU_BASH_SHELL
	if (override !== undefined && override !== '') {
		// Read as bash only when it is bash; anything else gets the reading
		// that holds for every POSIX shell.
		const name = override.slice(override.lastIndexOf('/') + 1)
		return { path: override, dialect: name === 'bash' ? 'bash' : 'sh', source: 'override' }
	}
	// Windows keeps Node's platform shell. Looking `bash` up on its PATH can
	// find WSL's launcher, which runs the command in another system.
	if (probe.platform === 'win32') return { path: undefined, dialect: 'sh', source: 'platform' }
	for (const directory of (probe.env.PATH ?? '').split(delimiter)) {
		if (directory === '' || !directory.startsWith('/')) continue
		const candidate = join(directory, 'bash')
		if (probe.isExecutable(candidate)) return { path: candidate, dialect: 'bash', source: 'bash' }
	}
	for (const candidate of WELL_KNOWN_BASH) {
		if (probe.isExecutable(candidate)) return { path: candidate, dialect: 'bash', source: 'bash' }
	}
	return { path: '/bin/sh', dialect: 'sh', source: 'sh' }
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK)
		return true
	} catch {
		return false
	}
}

let resolved: CommandShell | undefined

/**
 * The host's command shell, resolved once per process. The same value serves
 * the permission rules and the spawn, so the two cannot disagree.
 */
export function hostCommandShell(): CommandShell {
	if (resolved === undefined) {
		resolved = findCommandShell({ env: process.env, platform: process.platform, isExecutable })
	}
	return resolved
}

/** Replace the resolved host shell; `undefined` resolves again on next use. For tests. */
export function setHostCommandShellForTesting(shell: CommandShell | undefined): void {
	resolved = shell
}

/**
 * The spawn for one command on the host: executable, arguments, environment.
 * For bash, the variables that would change the line's meaning are dropped.
 */
export function hostShellSpawn(
	command: string,
	env: NodeJS.ProcessEnv,
	shell: CommandShell = hostCommandShell(),
): {
	readonly file: string | undefined
	readonly args: readonly string[]
	readonly env: NodeJS.ProcessEnv
} {
	if (shell.path === undefined) return { file: undefined, args: [command], env }
	if (shell.dialect !== 'bash') return { file: shell.path, args: ['-c', command], env }
	return { file: shell.path, args: ['-c', command], env: withoutBashStartup(env) }
}

export function withoutBashStartup<T extends Readonly<Record<string, string | undefined>>>(
	env: T,
): T {
	const out: Record<string, string | undefined> = {}
	for (const [name, value] of Object.entries(env)) {
		if (BASH_STARTUP_VARIABLES.has(name) || name.startsWith('BASH_FUNC_')) continue
		out[name] = value
	}
	return out as T
}

/**
 * The command a sandbox runs for one command line: bash when the guest has
 * it, `/bin/sh` otherwise. The rules read a sandboxed line in the `sh`
 * dialect, which holds for both. The command is passed as an argument, never
 * spliced into the launcher's text.
 *
 * The launcher does not `unset` the startup variables: where `/bin/sh` is
 * bash, `SHELLOPTS` arriving in the environment is readonly and `unset`
 * fails. The guest's environment is an allowlist plus the host's `env`, so
 * callers drop them from that `env` with {@link withoutBashStartup}.
 */
export const SANDBOX_SHELL_LAUNCHER =
	'if command -v bash >/dev/null 2>&1; then exec bash -c "$1"; fi; exec /bin/sh -c "$1"'

export function sandboxShellSpawn(command: string): {
	readonly file: string
	readonly args: string[]
} {
	return { file: '/bin/sh', args: ['-c', SANDBOX_SHELL_LAUNCHER, 'sh', command] }
}

/** The dialect a `bash` tool command is read in. */
export function bashToolDialect(context: { readonly sandboxed: boolean }): ShellDialect {
	return context.sandboxed ? 'sh' : hostCommandShell().dialect
}
