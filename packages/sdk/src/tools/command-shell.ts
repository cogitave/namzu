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
 *
 * ## Windows
 *
 * `cmd.exe` is a dialect the permission lexer cannot read: every command
 * line comes back opaque, so every call needs a person in every mode, and a
 * model writes POSIX syntax that cmd cannot run. So on Windows the same rule
 * applies as everywhere else: run bash where it exists, and read the line as
 * bash. The bash that exists on a Windows machine is Git for Windows'
 * (`findGitBash`). Without it the tool falls back to cmd, as before, and
 * {@link windowsShellNotice} says so once. `NAMZU_BASH_SHELL=cmd` keeps cmd
 * on a machine that has Git Bash.
 */

import {
	type ChildProcess,
	type SpawnOptions,
	execFileSync,
	spawn as nodeSpawn,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, accessSync, existsSync } from 'node:fs'
import { delimiter, isAbsolute, join, win32 } from 'node:path'

import { MSYS_TAG_VARIABLE, registerMsysShell } from '../process/kill-tree.js'
import type { ShellDialect } from '../types/tool/index.js'

/** The shell a host-side command runs in. */
export interface CommandShell {
	/** The executable, run as `<path> -c <command>`. Undefined: Node's platform shell (Windows). */
	readonly path: string | undefined
	/** How the permission rules read a line this shell runs. */
	readonly dialect: ShellDialect
	/** Where the choice came from, for diagnostics. */
	readonly source: 'override' | 'bash' | 'sh' | 'platform'
	/** True when this is a Windows executable (Git Bash), which needs Windows-only spawn details. */
	readonly windows?: true
}

/** What resolution looks at. Injected by tests to simulate a host without bash. */
export interface CommandShellProbe {
	readonly env: NodeJS.ProcessEnv
	readonly platform: NodeJS.Platform
	readonly isExecutable: (path: string) => boolean
	/**
	 * Windows only: the paths `where.exe git` prints, one per entry, in order.
	 * Absent or throwing means git was not found on PATH.
	 */
	readonly whereGit?: () => readonly string[]
	/** Windows only: the working directory, whose own programs are never trusted. Default: `process.cwd()`. */
	readonly cwd?: string
}

const WELL_KNOWN_BASH = ['/bin/bash', '/usr/bin/bash']
const WELL_KNOWN_SH = ['/bin/sh', '/usr/bin/sh']

/** Environment variables that change what a bash command line means. */
const BASH_STARTUP_VARIABLES = new Set(['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS'])

/** A variable of a Windows environment, whose names are not case-sensitive. */
function windowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
	return key === undefined ? undefined : env[key]
}

/** Is `path` the working directory or inside it? Windows paths compare without case. */
function insideDirectory(path: string, directory: string): boolean {
	const relative = win32.relative(directory, path)
	return relative === '' || (!relative.startsWith('..') && !win32.isAbsolute(relative))
}

/**
 * Git for Windows' bash.exe, found in this order:
 *
 * 1. `%ProgramFiles%\Git\bin\bash.exe`, then `%ProgramFiles(x86)%\Git\bin\bash.exe`;
 * 2. `%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe`, a per-user install;
 * 3. the install that holds the first `git` that `where.exe git` lists: its
 *    `bin\bash.exe`, one or two directories up from the `git.exe` it printed.
 *    A hit inside the working directory is skipped, because a repository can
 *    carry a `git.exe` of its own and the search must not run it.
 *
 * There is no registry lookup, and `where bash` is never asked: on a machine
 * with WSL, `System32\bash.exe` is the launcher of another system.
 */
export function findGitBash(probe: CommandShellProbe): string | undefined {
	const programFiles = windowsEnv(probe.env, 'ProgramFiles') ?? 'C:\\Program Files'
	const programFilesX86 = windowsEnv(probe.env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)'
	for (const root of [programFiles, programFilesX86]) {
		const candidate = win32.join(root, 'Git', 'bin', 'bash.exe')
		if (probe.isExecutable(candidate)) return candidate
	}
	// A per-user install (the installer's "just me" choice) lives under LOCALAPPDATA.
	const localAppData = windowsEnv(probe.env, 'LOCALAPPDATA')
	if (localAppData !== undefined && localAppData !== '') {
		const candidate = win32.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe')
		if (probe.isExecutable(candidate)) return candidate
	}
	let listed: readonly string[] = []
	try {
		listed = probe.whereGit?.() ?? []
	} catch {
		return undefined
	}
	const cwd = probe.cwd ?? process.cwd()
	for (const line of listed) {
		const git = line.trim()
		if (!win32.isAbsolute(git) || insideDirectory(git, cwd)) continue
		const directory = win32.dirname(git)
		// <Git>\cmd\git.exe and <Git>\bin\git.exe, then <Git>\mingw64\bin\git.exe.
		for (const candidate of [
			win32.join(directory, '..', 'bin', 'bash.exe'),
			win32.join(directory, '..', '..', 'bin', 'bash.exe'),
		]) {
			if (probe.isExecutable(candidate)) return candidate
		}
	}
	return undefined
}

export function findCommandShell(probe: CommandShellProbe): CommandShell {
	const override = probe.env.NAMZU_BASH_SHELL
	if (override !== undefined && override !== '') {
		// Read as bash only when it is bash; anything else gets the reading
		// that holds for every POSIX shell.
		const name =
			probe.platform === 'win32'
				? override
						.split(/[\\/]/)
						.at(-1)
						?.toLowerCase()
						.replace(/\.exe$/, '')
				: override.slice(override.lastIndexOf('/') + 1)
		// cmd is not a POSIX shell and takes no `-c`: naming it keeps Node's
		// own cmd path, which is how a Windows machine with Git Bash runs the
		// tool as it did before bash was preferred.
		if (probe.platform === 'win32' && name === 'cmd')
			return { path: undefined, dialect: 'cmd', source: 'override' }
		return {
			path: override,
			dialect: name === 'bash' ? 'bash' : 'sh',
			source: 'override',
			...(probe.platform === 'win32' ? { windows: true as const } : {}),
		}
	}
	// Looking `bash` up on the Windows PATH can find WSL's launcher, which
	// runs the command in another system, so only Git for Windows' own
	// install is used. Without it Node's platform shell (cmd) runs the line.
	if (probe.platform === 'win32') {
		const gitBash = findGitBash(probe)
		return gitBash === undefined
			? { path: undefined, dialect: 'cmd', source: 'platform' }
			: { path: gitBash, dialect: 'bash', source: 'bash', windows: true }
	}
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

/**
 * Said once, in the session, when a Windows machine has no Git Bash and the
 * `bash` tool runs cmd.exe. Undefined everywhere else.
 */
export const WINDOWS_CMD_FALLBACK_NOTICE =
	'Git for Windows not found — shell commands run in cmd.exe and each one asks for approval. Install Git for Windows for full support.'

export function windowsShellNotice(shell: CommandShell = hostCommandShell()): string | undefined {
	return shell.source === 'platform' && shell.path === undefined && shell.dialect === 'cmd'
		? WINDOWS_CMD_FALLBACK_NOTICE
		: undefined
}

/**
 * Is the host `bash` tool Git Bash on Windows? The model is then told so, and
 * the Windows-only spawn details apply.
 */
export function isWindowsBash(shell: CommandShell = hostCommandShell()): boolean {
	return shell.windows === true && shell.dialect === 'bash'
}

/** What a model needs to know when the `bash` tool is Git Bash on Windows, appended to the tool's description. */
export const WINDOWS_BASH_GUIDANCE =
	'This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell. Use Unix shell syntax: `/dev/null` not `NUL`, forward slashes, `$VAR` not `%VAR%` or `$env:VAR`. To run PowerShell, call `powershell -NoProfile -Command "…"`.'

/**
 * Rewrite a redirect to Windows' `NUL` device (`>nul`, `2>NUL`, `&>nul`) to
 * `/dev/null`. In bash `nul` is an ordinary file name, so the line would
 * create a file called `nul` that Windows then cannot delete. A line with
 * `<`, `$` or a backtick is left alone: it may be a heredoc or a string that
 * only mentions the text.
 */
export function rewriteWindowsNullRedirect(command: string): string {
	if (/[<$`]/.test(command)) return command
	return command.replace(/(\d?&?>+[ \t]*)nul(?=\s|$|[|&;)\n])/gi, '$1/dev/null')
}

/** `where.exe git`, run from the system directory by its absolute path, so PATH cannot stand in for it. */
function whereGit(): readonly string[] {
	const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
	const output = execFileSync(win32.join(root, 'System32', 'where.exe'), ['git'], {
		encoding: 'utf8',
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'ignore'],
		timeout: 5000,
	})
	return output.split(/\r?\n/)
}

/**
 * An explicitly requested interpreter for a host script. Unlike the live
 * `bash` tool's automatic choice, this never substitutes bash for sh (or sh
 * for bash). A matching `NAMZU_BASH_SHELL` override is authoritative: if it
 * disappeared, an already-confirmed script must stop rather than silently
 * switch to a different executable.
 */
export function findCommandShellForDialect(
	dialect: 'bash' | 'sh',
	probe: CommandShellProbe,
): (CommandShell & { readonly dialect: 'bash' | 'sh' }) | undefined {
	if (probe.platform === 'win32') return undefined
	const override = probe.env.NAMZU_BASH_SHELL
	if (override) {
		const name = override.slice(override.lastIndexOf('/') + 1)
		if (name === dialect) {
			return isAbsolute(override) && probe.isExecutable(override)
				? { path: override, dialect, source: 'override' }
				: undefined
		}
	}
	const name = dialect
	// A scheduled script's interpreter must not drift merely because the
	// service's PATH gained another same-named binary after confirmation.
	for (const candidate of dialect === 'bash' ? WELL_KNOWN_BASH : WELL_KNOWN_SH) {
		if (probe.isExecutable(candidate)) return { path: candidate, dialect, source: dialect }
	}
	for (const directory of (probe.env.PATH ?? '').split(delimiter)) {
		if (directory === '' || !directory.startsWith('/')) continue
		const candidate = join(directory, name)
		if (probe.isExecutable(candidate)) return { path: candidate, dialect, source: dialect }
	}
	return undefined
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
		resolved = findCommandShell({
			env: process.env,
			platform: process.platform,
			isExecutable,
			whereGit,
		})
	}
	return resolved
}

/** Re-check the requested executable each time a job is confirmed or fired. */
export function installedCommandShellForDialect(
	dialect: 'bash' | 'sh',
): (CommandShell & { readonly dialect: 'bash' | 'sh' }) | undefined {
	return findCommandShellForDialect(dialect, {
		env: process.env,
		platform: process.platform,
		isExecutable,
	})
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
	const clean = withoutBashStartup(env)
	// Git for Windows: the line is read as bash, so `>nul` must already have
	// become `/dev/null` (the tool's input does that before the rules read it;
	// this covers a caller that did not), and git must never open an editor.
	if (shell.windows === true)
		return {
			file: shell.path,
			args: ['-c', rewriteWindowsNullRedirect(command)],
			env: { ...clean, GIT_EDITOR: 'true' },
		}
	return { file: shell.path, args: ['-c', command], env: clean }
}

/** Why a command could not be started, in the words a model or operator reads. */
export function describeSpawnFailure(error: unknown, cwd?: string): string {
	// Node reports a missing working directory as ENOENT on the shell's own
	// path ("spawn C:\Windows\system32\cmd.exe ENOENT"), which sends the reader
	// looking for a missing shell. Say what is actually missing.
	if (
		cwd !== undefined &&
		(error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' &&
		!existsSync(cwd)
	) {
		return `Could not start the command: the working directory does not exist: ${cwd}`
	}
	const detail = error instanceof Error ? error.message : String(error)
	return `Could not start the command: ${detail}`
}

/** Environment variable that carries the command line into the inner cmd. */
const WINDOWS_COMMAND_VARIABLE = 'NAMZU_HOST_COMMAND'
const WINDOWS_SHELL_VARIABLE = 'NAMZU_HOST_COMSPEC'

/**
 * The spawn for one command line under cmd on Windows: the outer cmd's file,
 * its arguments and the environment that carries the command.
 *
 * A bare `cmd /d /s /c <command>` converts the command line to the console's
 * OEM code page before it runs anything, so letters that page lacks arrive
 * as their nearest ASCII look-alike (g-breve as `g`, s-cedilla as `s` on
 * CP850) and are gone before the command writes a byte. `chcp` inside the
 * same line is too late: the line is already converted. So the outer cmd
 * only switches the console to UTF-8 and starts a second cmd, and the
 * command travels in the environment, which is Unicode and never converted.
 * The outer cmd reads it with delayed expansion (`!NAME!`), which happens
 * after its line is parsed, so quotes, `&`, `|` and `>` in the command are
 * inert there and reach the second cmd as the line it was given: quoting,
 * `%` and redirection mean what they meant before, and its exit code is the
 * command's. Neither cmd is looked up on PATH, so a `cmd.exe` in the
 * working directory is never picked up.
 */
function windowsCmdSpawn(
	command: string,
	env: NodeJS.ProcessEnv,
): {
	readonly file: string
	readonly args: readonly string[]
	readonly env: NodeJS.ProcessEnv
} {
	const lookup = (name: string): string | undefined => {
		const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
		return key === undefined ? undefined : env[key]
	}
	const comspec =
		lookup('ComSpec') ??
		`${lookup('SystemRoot') ?? process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`
	return {
		file: comspec,
		// Passed verbatim: Node must not re-quote the line, whose outer quotes
		// `/s` strips.
		args: [
			'/d',
			'/v:on',
			'/s',
			'/c',
			`"chcp 65001>nul & "!${WINDOWS_SHELL_VARIABLE}!" /d /s /c "!${WINDOWS_COMMAND_VARIABLE}!""`,
		],
		env: { ...env, [WINDOWS_SHELL_VARIABLE]: comspec, [WINDOWS_COMMAND_VARIABLE]: command },
	}
}

/**
 * Start one command on the host, in the shell {@link hostCommandShell} chose.
 *
 * The ONE place that knows what Windows needs: with no shell path (cmd), Node
 * itself must run the line (`cmd.exe /d /s /c`, see `windowsCmdSpawn`);
 * everywhere else it is `<shell> -c <command>`. The foreground `bash` tool,
 * the background job registry and plugin hooks all spawn through here, so
 * they cannot diverge: the registry once spawned `/bin/sh` on Windows while
 * the foreground tool did not, and every background job died at once with no
 * message.
 *
 * - On Windows the line runs under UTF-8 (see `windowsCmdSpawn`).
 * - `detached` (own process group, for `killTree`) is POSIX only; on Windows
 *   it opens a new console window instead.
 * - `windowsHide` keeps a GUI host from flashing a console per command.
 */
export function spawnHostShell(
	command: string,
	options: {
		readonly cwd: string
		readonly env: NodeJS.ProcessEnv
		readonly stdio?: SpawnOptions['stdio']
		/** Default: true off Windows. */
		readonly detached?: boolean
		readonly shell?: CommandShell
		/** For tests: the platform the options are shaped for. */
		readonly platform?: NodeJS.Platform
		/** For tests: the spawn that runs it. */
		readonly spawnImpl?: typeof nodeSpawn
	},
): ChildProcess {
	const spawnFn = options.spawnImpl ?? nodeSpawn
	const shell = options.shell ?? hostCommandShell()
	const spawned = hostShellSpawn(command, options.env, shell)
	// Git Bash: tag the shell so a kill can find what a forked command left.
	const tag = shell.windows === true && shell.path !== undefined ? randomUUID() : undefined
	const resolved =
		tag === undefined ? spawned : { ...spawned, env: { ...spawned.env, [MSYS_TAG_VARIABLE]: tag } }
	const common: SpawnOptions = {
		cwd: options.cwd,
		env: resolved.env,
		detached: options.detached ?? (options.platform ?? process.platform) !== 'win32',
		windowsHide: true,
		// Git Bash reads no terminal: a command that asks for input gets
		// end-of-file (the null device) instead of waiting for a timeout.
		...(options.stdio === undefined
			? resolved.file !== undefined && shell.windows === true
				? { stdio: ['ignore', 'pipe', 'pipe'] as SpawnOptions['stdio'] }
				: {}
			: { stdio: options.stdio }),
	}
	if (resolved.file !== undefined) {
		const child = spawnFn(resolved.file, [...resolved.args], common)
		if (tag !== undefined && child !== null && typeof child === 'object')
			registerMsysShell(child, { bash: resolved.file, tag })
		return child
	}
	const windows = windowsCmdSpawn(command, resolved.env)
	return spawnFn(windows.file, [...windows.args], {
		...common,
		env: windows.env,
		windowsVerbatimArguments: true,
	})
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
