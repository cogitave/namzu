/**
 * Terminal tabs: what a tab is, what it runs, and what its badge says.
 *
 * Everything here is pure. Main resolves programs on disk and starts the process;
 * this decides the argument lists, the Windows launch shape and the activity state, so
 * each one is a table a test can read.
 */
import type { ReasoningEffort, ReviewMode } from '@namzu/sdk'

export type TerminalEngine = 'namzu' | 'codex-cli' | 'claude-code'

export const TERMINAL_ENGINE_LABELS: Record<TerminalEngine, string> = {
	namzu: 'Namzu',
	'codex-cli': 'Codex CLI',
	'claude-code': 'Claude Code',
}

const TAB_PREFIX = 'terminal-'
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A terminal's tab shares the workspace layout's id space with conversations. */
export function terminalTabId(hostId: string): string {
	return `${TAB_PREFIX}${hostId}`
}

export function isTerminalTabId(value: unknown): boolean {
	return typeof value === 'string' && value.startsWith(TAB_PREFIX) && HOST_ID.test(value.slice(9))
}

export function terminalHostId(tabId: string): string {
	if (!isTerminalTabId(tabId)) throw new Error('Invalid terminal tab.')
	return tabId.slice(TAB_PREFIX.length)
}

/** `working` and `waiting` and `idle` are for a running engine CLI; `exited` for any ended tab. */
export type TerminalActivity = 'working' | 'waiting' | 'idle' | 'exited'

export interface TerminalTabView {
	/** `terminal-<host id>`. */
	id: string
	projectId: string
	kind: 'shell' | 'engine'
	engine?: TerminalEngine
	title: string
	/**
	 * `running` has a live process. `exited` ended while the app ran; `restored` was running when
	 * the app last closed, so only its last screen is left.
	 */
	status: 'running' | 'exited' | 'restored'
	exitCode?: number
	/** Present on an engine CLI tab. */
	activity?: TerminalActivity
	createdAt: number
}

/** Output within this long ago still counts as the program working. */
export const ACTIVITY_WORKING_MS = 1_500
/** A program quiet for longer than this is idle rather than waiting on the person. */
export const ACTIVITY_IDLE_MS = 60_000

/**
 * Where an engine CLI stands, from nothing but its output and its end. A program that printed and
 * then went quiet is waiting for the person; one quiet for a minute is idle. Telling a prompt for
 * approval from a finished answer needs the screen, which is not read here.
 */
export function terminalActivity(input: {
	status: TerminalTabView['status']
	lastOutputAt: number | undefined
	now: number
}): TerminalActivity {
	if (input.status !== 'running') return 'exited'
	if (input.lastOutputAt === undefined) return 'working'
	const quiet = input.now - input.lastOutputAt
	if (quiet < ACTIVITY_WORKING_MS) return 'working'
	return quiet < ACTIVITY_IDLE_MS ? 'waiting' : 'idle'
}

export const ACTIVITY_LABELS: Record<TerminalActivity, string> = {
	working: 'Working',
	waiting: 'Waiting for input',
	idle: 'Idle',
	exited: 'Exited',
}

/** The tab title: the engine and the project, or the shell's own name. */
export function terminalTitle(input: {
	kind: 'shell' | 'engine'
	engine?: TerminalEngine
	projectName: string
	shell?: string
}): string {
	if (input.kind === 'engine' && input.engine)
		return `${TERMINAL_ENGINE_LABELS[input.engine]} · ${input.projectName}`
	return input.shell ?? 'Terminal'
}

/* ------------------------------------------------------------------ shells */

export type ShellChoice = 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'wsl'
export const SHELL_CHOICES: readonly ShellChoice[] = ['auto', 'pwsh', 'powershell', 'cmd', 'wsl']

export const SHELL_CHOICE_LABELS: Record<ShellChoice, string> = {
	auto: 'Automatic',
	pwsh: 'PowerShell 7',
	powershell: 'Windows PowerShell',
	cmd: 'Command Prompt',
	wsl: 'WSL',
}

export interface TerminalLaunch {
	command: string
	args: string[]
	/** A value sets the variable; null removes it. */
	env?: Record<string, string | null>
	title: string
}

export interface ShellEnvironment {
	platform: NodeJS.Platform
	env: Record<string, string | undefined>
	/** The absolute path of a program found on this machine, or undefined. */
	find: (name: string) => string | undefined
}

/**
 * Which shells the machine offers for the setting. `auto` is always there. Elsewhere than Windows
 * the person's own login shell is the only choice.
 */
export function availableShells(host: ShellEnvironment): ShellChoice[] {
	if (host.platform !== 'win32') return ['auto']
	const found: ShellChoice[] = ['auto']
	if (host.find('pwsh.exe')) found.push('pwsh')
	if (host.find('powershell.exe')) found.push('powershell')
	found.push('cmd')
	if (host.find('wsl.exe')) found.push('wsl')
	return found
}

const CMD_UTF8 = 'chcp 65001>nul'

/**
 * The program a plain terminal tab runs.
 *
 * Windows PowerShell 5.1 silently drops a typed capital dotless-I with a dot, which a Turkish
 * keyboard produces, so `auto` prefers PowerShell 7 and otherwise Command Prompt switched to UTF-8
 * rather than Windows PowerShell. A choice that is not installed falls back to `auto`.
 */
export function resolveShell(choice: ShellChoice, host: ShellEnvironment): TerminalLaunch {
	if (host.platform !== 'win32') {
		const shell = host.env.SHELL
		if (shell && shell.length > 0) return { command: shell, args: [], title: shellName(shell) }
		return host.platform === 'darwin'
			? { command: '/bin/zsh', args: [], title: 'zsh' }
			: { command: '/bin/sh', args: [], title: 'sh' }
	}
	const pwsh = host.find('pwsh.exe')
	const powershell = host.find('powershell.exe')
	const wsl = host.find('wsl.exe')
	const command = host.env.ComSpec || host.find('cmd.exe') || 'cmd.exe'
	const cmd: TerminalLaunch = {
		command,
		args: ['/d', '/k', CMD_UTF8],
		title: 'Command Prompt',
	}
	if (choice === 'powershell' && powershell)
		return { command: powershell, args: ['-NoLogo'], title: 'Windows PowerShell' }
	if (choice === 'wsl' && wsl) return { command: wsl, args: [], title: 'WSL' }
	if (choice === 'cmd') return cmd
	// `auto`, and a choice this machine does not have: PowerShell 7 when installed, else Command Prompt.
	if (pwsh) return { command: pwsh, args: ['-NoLogo'], title: 'PowerShell' }
	if (choice === 'pwsh' && powershell)
		return { command: powershell, args: ['-NoLogo'], title: 'Windows PowerShell' }
	return cmd
}

function shellName(path: string): string {
	const name = path.replaceAll('\\', '/').split('/').pop() ?? path
	return name.replace(/\.exe$/iu, '') || path
}

/* ----------------------------------------------------------------- engines */

export interface EngineChoices {
	engine: TerminalEngine
	/** The provider id of a Namzu session; the other engines are their own provider. */
	provider?: string
	model?: string
	effort?: ReasoningEffort
	permissionMode: ReviewMode
	/** What the person typed in the composer: the first message of the engine's CLI (`--message=` for Namzu). */
	prompt?: string
}

/** How the host starts what it launches: the Desktop's own runtime for Namzu, an installed CLI otherwise. */
export interface EngineHost {
	platform: NodeJS.Platform
	/** Electron's binary, run as Node for the bundled CLI. */
	execPath: string
	/** The bundled CLI entry; absent in development with the installed `namzu`. */
	cliEntry?: string
	/** Node flags that must precede the entry, as the Desktop runtime passes them. */
	nodeArgs: string[]
	/** Absolute path of Command Prompt; a bare name would be searched for in the project folder first. */
	commandPrompt?: string
	/** Where an installed engine's program is, and whether it is a native program or an npm shim. */
	resolve: (name: 'codex' | 'claude') => { path: string; shim: boolean } | undefined
}

export interface EngineLaunch extends TerminalLaunch {
	/** Choices this engine cannot take, named for the person. */
	omitted: string[]
}

const CODEX_EFFORTS: readonly ReasoningEffort[] = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
]
const CLAUDE_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Codex's approval flag takes only `on-request` and `never`: a config value of `untrusted` is no
 * longer accepted and stops the program from starting. The stricter modes therefore ask on request
 * under a sandbox that cannot write, or write only inside the workspace.
 */
export function codexPermissionArgs(mode: ReviewMode): string[] {
	switch (mode) {
		case 'accept-edits':
			return ['-a', 'on-request', '-s', 'workspace-write']
		case 'auto':
			return ['-a', 'on-request', '-s', 'danger-full-access']
		case 'plan':
		case 'strict':
			return ['-a', 'never', '-s', 'read-only']
		default:
			return ['-a', 'on-request', '-s', 'read-only']
	}
}

export function secondEnginePermissionArgument(mode: ReviewMode): string {
	switch (mode) {
		case 'accept-edits':
			return 'acceptEdits'
		case 'auto':
			return 'bypassPermissions'
		case 'plan':
			return 'plan'
		case 'strict':
			return 'dontAsk'
		default:
			return 'default'
	}
}

/** Characters Command Prompt reads as syntax or expands, even inside a `/c` line. */
const CMD_SYNTAX = /[&|<>^%"!`\r\n\0]/u

/** Command Prompt reads a line of at most 8191 characters; stay clear of the edge. */
const CMD_LINE_LIMIT = 8_000

const COMMAND_PROMPT_REFUSALS = [
	'A value in this launch cannot be passed through Command Prompt safely.',
	'This launch is too long to pass through Command Prompt.',
]

function isCommandPromptRefusal(error: unknown): boolean {
	return error instanceof Error && COMMAND_PROMPT_REFUSALS.includes(error.message)
}

/**
 * A Windows pseudo-console runs Electron-as-Node and npm's `.cmd` shims through
 * `cmd.exe /d /c call <program> <arguments>`. node-pty quotes each argument that holds a space, and
 * Command Prompt drops the first and last quote of a line that begins with one, which would break a
 * program path with a space in it, so the line starts with the word `call` instead. An argument
 * holding Command Prompt syntax cannot be made safe in that line, so it is refused.
 */
function viaCommandPrompt(
	program: string,
	args: string[],
	commandPrompt = 'cmd.exe',
): Pick<TerminalLaunch, 'command' | 'args'> {
	for (const part of [program, ...args])
		if (CMD_SYNTAX.test(part)) throw new Error(COMMAND_PROMPT_REFUSALS[0])
	if ([program, ...args].join(' ').length > CMD_LINE_LIMIT)
		throw new Error(COMMAND_PROMPT_REFUSALS[1])
	return { command: commandPrompt, args: ['/d', '/c', 'call', program, ...args] }
}

function wrap(
	host: EngineHost,
	program: string,
	args: string[],
	needsCommandPrompt: boolean,
): Pick<TerminalLaunch, 'command' | 'args'> {
	return host.platform === 'win32' && needsCommandPrompt
		? viaCommandPrompt(program, args, host.commandPrompt)
		: { command: program, args }
}

/**
 * The program, arguments and environment for an engine's own CLI with the composer's choices.
 * Choices apply to that one terminal; none is written anywhere.
 */
export function buildEngineLaunch(
	choices: EngineChoices,
	host: EngineHost,
	project: { name: string },
): EngineLaunch {
	const omitted: string[] = []
	const title = terminalTitle({
		kind: 'engine',
		engine: choices.engine,
		projectName: project.name,
	})
	if (choices.engine === 'namzu') {
		const args: string[] = []
		if (choices.provider) args.push('--provider', choices.provider)
		if (choices.model) args.push('--model', choices.model)
		if (choices.effort) args.push('--effort', choices.effort)
		args.push('--permission-mode', choices.permissionMode)
		const message = choices.prompt?.trim() ? choices.prompt : undefined
		// `--message=<text>` is one argument, so a leading dash or a space in the message is not parsed
		// as anything else; the TUI sends it once, as a plain prompt, when its composer is ready.
		const namzuLaunch = (withMessage: boolean) => {
			const all = withMessage && message ? [...args, `--message=${message}`] : args
			if (host.cliEntry) {
				const launch = wrap(host, host.execPath, [...host.nodeArgs, host.cliEntry, ...all], true)
				return { ...launch, env: { ELECTRON_RUN_AS_NODE: '1' }, title, omitted }
			}
			// A bare `namzu` is resolved from the project folder first by Command Prompt, so a trusted
			// repository could plant one; without the bundled entry there is nothing safe to run.
			if (host.platform === 'win32')
				throw new Error('The bundled Namzu CLI is not available, so it cannot be started here.')
			return { ...wrap(host, 'namzu', all, true), title, omitted }
		}
		if (message) {
			try {
				return namzuLaunch(true)
			} catch (error) {
				// Only Command Prompt's refusal of the message is recoverable; anything else stands.
				if (!isCommandPromptRefusal(error)) throw error
				omitted.push(PROMPT_NOT_PASSED)
			}
		}
		return namzuLaunch(false)
	}
	const name = choices.engine === 'codex-cli' ? 'codex' : 'claude'
	const program = host.resolve(name)
	if (!program)
		throw new Error(
			`${TERMINAL_ENGINE_LABELS[choices.engine]} is not installed, or is not on this app's PATH.`,
		)
	const args: string[] = []
	if (choices.engine === 'codex-cli') {
		if (choices.model) args.push('-m', choices.model)
		if (choices.effort) {
			if (CODEX_EFFORTS.includes(choices.effort))
				args.push('-c', `model_reasoning_effort=${choices.effort}`)
			else omitted.push(`the ${choices.effort} effort`)
		}
		args.push(...codexPermissionArgs(choices.permissionMode))
	} else {
		if (choices.model) args.push('--model', choices.model)
		if (choices.effort) {
			if (CLAUDE_EFFORTS.includes(choices.effort)) args.push('--effort', choices.effort)
			else omitted.push(`the ${choices.effort} effort`)
		}
		args.push('--permission-mode', secondEnginePermissionArgument(choices.permissionMode))
	}
	if (choices.prompt?.trim()) {
		// After `--`, so a message that begins with a dash is a message, not an option.
		const withPrompt = [...args, '--', choices.prompt]
		try {
			return { ...wrap(host, program.path, withPrompt, program.shim), title, omitted }
		} catch (error) {
			if (!isCommandPromptRefusal(error)) throw error
			// Command Prompt would read the message as syntax; it stays in the composer for the person to type.
			omitted.push(PROMPT_NOT_PASSED)
		}
	}
	return { ...wrap(host, program.path, args, program.shim), title, omitted }
}

/** In `omitted` when the composer's message could not travel on the command line. */
export const PROMPT_NOT_PASSED = 'your message'

/** `where`-style lookup of a Windows program over PATH and the places npm installs shims. */
export function findWindowsProgram(
	name: string,
	input: {
		path: string
		extensions: readonly string[]
		extraDirectories?: readonly string[]
		exists: (path: string) => boolean
	},
): { path: string; shim: boolean } | undefined {
	const directories = [...input.path.split(';').filter(Boolean), ...(input.extraDirectories ?? [])]
	for (const extension of input.extensions) {
		for (const directory of directories) {
			const candidate = `${directory.replace(/[\\/]+$/u, '')}\\${name}${extension}`
			if (input.exists(candidate)) return { path: candidate, shim: extension !== '.exe' }
		}
	}
	return undefined
}
