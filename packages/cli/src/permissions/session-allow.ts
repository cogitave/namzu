/**
 * What a "don't ask again" answer remembers.
 *
 * Each answer is offered as a permission suggestion that "yes"
 * applies and that is written to the project's local settings file. This is the
 * Namzu side of that: an allow the operator gave at a prompt, written to the
 * project's `namzu.config.local.json` (see `local-settings.ts`), where the next
 * session reads it back as the local layer of the config cascade, and held in
 * memory as well so it applies to the very next call. It sits AFTER the
 * operator's `[permissions]` table and the dangerous-pattern floor (first
 * match wins), so a `deny` or an explicit `ask` still decides first, and a
 * kernel escalation (a sandbox escape, a path outside the roots, a protected
 * path, a catastrophic removal) is reviewed whatever any rule says.
 *
 * A command is remembered as its first two
 * words and a star (`git commit *`) when the second word is a plain
 * subcommand and the first is not a shell or a wrapper; the exact command
 * otherwise. A compound line gets one rule per command in it.
 */

import {
	AuthorizationGate,
	type AuthorizationPredicateCall,
	type AuthorizationRule,
	NOOP_LOGGER,
	lexShellCommandLine,
} from '@namzu/sdk'

import { cliLogger } from '../logging.js'
import {
	LOCAL_CONFIG_FILE,
	ensureLocalConfigIgnored,
	logIgnoreOutcome,
	writeLocalAllows,
} from './local-settings.js'
import { type PermissionsConfig, compilePermissions } from './rules.js'

export type SessionAllow =
	/** One command, exactly as written. */
	| { readonly kind: 'command'; readonly tool: string; readonly command: string }
	/** Every command that starts with these words (`git commit` -> `git commit *`). */
	| { readonly kind: 'prefix'; readonly tool: string; readonly prefix: string }
	| { readonly kind: 'host'; readonly tool: string; readonly host: string }
	| { readonly kind: 'tool'; readonly tool: string }

/** The slice of a reviewed call this module reads. */
export interface AllowableCall {
	readonly name: string
	readonly input: unknown
	readonly isDestructive?: boolean
	readonly requiresApproval?: boolean
	readonly authorization?: { readonly explicitReview?: boolean }
	readonly escalation?: unknown
}

export const WEB_FETCH_TOOL = 'web_fetch'
const MAX_LABEL_COMMAND = 60
/** Rules one answer may write; a compound line stops at five. */
export const MAX_RULES_PER_ANSWER = 5

/** Tools whose command line is one argument; `bash` today. */
export type CommandArguments = ReadonlyMap<string, string>

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A call a rule must never cover: it asks every time, whatever was said before. */
function alwaysAsked(call: AllowableCall): boolean {
	return (
		call.escalation !== undefined ||
		call.requiresApproval === true ||
		call.authorization?.explicitReview === true ||
		call.isDestructive === true
	)
}

// ---------------------------------------------------------------------------
// the shape of a suggested command rule
// ---------------------------------------------------------------------------

/**
 * Programs that run another command line: a prefix rule naming one would
 * cover whatever it is handed. This list is matched on the
 * program's basename.
 */
const NO_PREFIX_PROGRAMS: ReadonlySet<string> = new Set([
	'sh',
	'bash',
	'zsh',
	'fish',
	'csh',
	'tcsh',
	'ksh',
	'dash',
	'cmd',
	'powershell',
	'pwsh',
	'env',
	'xargs',
	'command',
	'builtin',
	'noglob',
	'nice',
	'stdbuf',
	'nohup',
	'timeout',
	'time',
	'watch',
	'ionice',
	'chrt',
	'setsid',
	'taskset',
	'strace',
	'ltrace',
	'script',
	'flock',
	'unshare',
	'nsenter',
	'sudo',
	'doas',
	'pkexec',
	'su',
	'runuser',
])

/** A subcommand word: lower-case words joined by single hyphens (`commit`, `cherry-pick`). */
const SUBCOMMAND = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const ASSIGNMENT = /^[A-Za-z_]\w*=/
/** A program name that is safe to write into a rule as it stands. */
const PLAIN_PROGRAM = /^[\w./+@:-]+$/
/** What would widen or reshape a rule written as an exact command. */
const NOT_EXACT = /[\n\r;&|<>`$()*?{}\\]/

function programName(word: string): string {
	return word.slice(word.lastIndexOf('/') + 1)
}

/**
 * The first two words of a command, when they would be offered as a
 * rule: at least two words, the first not a shell or a wrapper, the second a
 * plain subcommand. `git commit -m x` gives `git commit`; `git -C dir status`,
 * `bash -c x`, `sudo ls` and `ls -la` give nothing.
 *
 * A line that starts with a variable assignment gives nothing either. Namzu does not strip safe
 * assignments: a rule is matched against the
 * command as written, assignments included, so the prefix would never match
 * the line it was offered for.
 */
export function twoWordPrefix(command: string): string | undefined {
	const words = command.trim().split(/\s+/).filter(Boolean)
	const [program, subcommand] = words
	if (words.length < 2 || program === undefined || subcommand === undefined) return undefined
	if (ASSIGNMENT.test(program)) return undefined
	if (!PLAIN_PROGRAM.test(program) || NO_PREFIX_PROGRAMS.has(programName(program))) return undefined
	if (!SUBCOMMAND.test(subcommand)) return undefined
	return `${program} ${subcommand}`
}

/** The allow one plain command is remembered as: its two-word prefix, else itself. */
function allowForCommand(tool: string, command: string): SessionAllow | undefined {
	if (NOT_EXACT.test(command)) return undefined
	// `cd` never widens: `cd src *` would cover every directory named src-anything.
	const prefix =
		programName(command.split(/\s+/)[0] ?? '') === 'cd' ? undefined : twoWordPrefix(command)
	if (prefix !== undefined) return { kind: 'prefix', tool, prefix }
	return { kind: 'command', tool, command }
}

/**
 * The commands a line runs, when every one of them is a plain command: the
 * line parses completely, nothing in it is read at run time, and no command
 * carries a redirection. Anything else has no rule that covers it.
 */
function plainCommands(line: string): readonly string[] | undefined {
	const lexed = lexShellCommandLine(line, { dialect: 'bash' })
	if (!lexed.complete || lexed.opaque || lexed.commands.length === 0) return undefined
	if (lexed.redirections.length > 0 || lexed.compoundWords.length > 0) return undefined
	const out: string[] = []
	for (const command of lexed.commands) {
		if (command.origin !== 'line' || command.redirections.length > 0) return undefined
		const text = command.text.trim()
		if (text === '') return undefined
		out.push(text)
	}
	return out
}

/**
 * The allows a "don't ask again" answer would remember for one call, or none.
 *
 * One plain command gives one rule. A compound line gives one rule per command
 * in it, up to five; the rules only help together, so a
 * line any of whose commands has no rule form (a glob, a substitution, a
 * redirection) gives none. A line that spans several lines, or carries a
 * here-document, gives none either: the first line's prefix would cover
 * whatever follows it, and a Namzu rule is
 * matched command by command.
 */
export function allowsFor(
	call: AllowableCall,
	commands: CommandArguments,
): readonly SessionAllow[] | undefined {
	if (alwaysAsked(call)) return undefined
	const input = isRecord(call.input) ? call.input : undefined
	const commandArgument = commands.get(call.name)
	if (commandArgument !== undefined) {
		const line = input?.[commandArgument]
		if (typeof line !== 'string') return undefined
		if (input?.dangerously_disable_sandbox === true) return undefined
		if (line.trim() === '' || /[\n\r]/.test(line.trim())) return undefined
		const parts = plainCommands(line)
		if (parts === undefined) return undefined
		const out: SessionAllow[] = []
		for (const part of parts) {
			const allow = allowForCommand(call.name, part)
			if (allow === undefined) return undefined
			if (!out.some((existing) => sameAllow(existing, allow))) out.push(allow)
		}
		return out.length > 0 && out.length <= MAX_RULES_PER_ANSWER ? out : undefined
	}
	if (call.name === WEB_FETCH_TOOL) {
		const url = input?.url
		if (typeof url !== 'string') return undefined
		try {
			const host = new URL(url).hostname
			if (host === '' || host.includes('*')) return undefined
			return [{ kind: 'host', tool: call.name, host }]
		} catch {
			return undefined
		}
	}
	if (call.name.startsWith('mcp__')) return [{ kind: 'tool', tool: call.name }]
	return undefined
}

/** The one allow of a call that has exactly one, or none. */
export function allowFor(
	call: AllowableCall,
	commands: CommandArguments,
): SessionAllow | undefined {
	const all = allowsFor(call, commands)
	return all?.length === 1 ? all[0] : undefined
}

/**
 * The allows that cover every call of a batch, or none when any call has no
 * allow of its own: an answer is offered only where it holds for the whole
 * batch.
 */
export function allowsForBatch(
	calls: readonly AllowableCall[],
	commands: CommandArguments,
): readonly SessionAllow[] | undefined {
	if (calls.length === 0) return undefined
	const out: SessionAllow[] = []
	for (const call of calls) {
		const allows = allowsFor(call, commands)
		if (!allows) return undefined
		for (const allow of allows) {
			if (!out.some((existing) => sameAllow(existing, allow))) out.push(allow)
		}
	}
	return out.length <= MAX_RULES_PER_ANSWER ? out : undefined
}

export function sameAllow(a: SessionAllow, b: SessionAllow): boolean {
	if (a.kind !== b.kind || a.tool !== b.tool) return false
	if (a.kind === 'command' && b.kind === 'command') return a.command === b.command
	if (a.kind === 'prefix' && b.kind === 'prefix') return a.prefix === b.prefix
	if (a.kind === 'host' && b.kind === 'host') return a.host === b.host
	return true
}

function shorten(text: string): string {
	return text.length > MAX_LABEL_COMMAND ? `${text.slice(0, MAX_LABEL_COMMAND - 1)}…` : text
}

/** The phrase after "don't ask again for", short enough for one line. */
export function describeAllows(allows: readonly SessionAllow[]): string {
	const parts = allows.map((allow) => {
		switch (allow.kind) {
			case 'command':
				return `${shorten(allow.command)} commands`
			case 'prefix':
				return `${shorten(allow.prefix)} * commands`
			case 'host':
				return allow.host
			case 'tool':
				return allow.tool.replace(/^mcp__/, '').replace(/__/g, ' ')
		}
	})
	return parts.length <= 1
		? (parts[0] ?? '')
		: `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

// ---------------------------------------------------------------------------
// as `[permissions]` entries
// ---------------------------------------------------------------------------

/**
 * The `[permissions]` table that says what these allows say. The same table is
 * written to the local config and compiled for the current session, so what is
 * remembered now and what is read back tomorrow cannot differ.
 */
export function permissionsForAllows(allows: readonly SessionAllow[]): PermissionsConfig {
	const table: Record<string, Record<string, 'allow'> | 'allow'> = {}
	const pattern = (tool: string, glob: string) => {
		const existing = table[tool]
		const patterns = typeof existing === 'object' ? existing : {}
		patterns[glob] = 'allow'
		table[tool] = patterns
	}
	for (const allow of allows) {
		switch (allow.kind) {
			case 'command':
				pattern(allow.tool, allow.command)
				break
			case 'prefix':
				pattern(allow.tool, `${allow.prefix} *`)
				break
			case 'host':
				// Both schemes, and the slash after the host: `https://example.com/*`
				// cannot match `https://example.com.evil.test/`.
				pattern(allow.tool, `http://${allow.host}/*`)
				pattern(allow.tool, `https://${allow.host}/*`)
				break
			case 'tool':
				table[allow.tool] = 'allow'
				break
		}
	}
	return table
}

export interface SessionAllows {
	/**
	 * Remember these allows: for this session at once, and in the project's
	 * local config for the next. Returns a sentence when the file could not be
	 * written (the session still has them).
	 */
	add(allows: readonly SessionAllow[]): string | undefined
	list(): readonly SessionAllow[]
	/** One kernel rule that consults the store at every call. */
	readonly rule: AuthorizationRule
}

export interface SessionAllowsOptions {
	/** The folder whose `namzu.config.local.json` receives the answers. Absent: memory only. */
	readonly cwd?: string | (() => string | undefined)
	/** Overridable for tests. */
	readonly persist?: typeof writeLocalAllows
	readonly keepIgnored?: typeof ensureLocalConfigIgnored
}

export function createSessionAllows(
	_commands: CommandArguments,
	options: SessionAllowsOptions = {},
): SessionAllows {
	const entries: SessionAllow[] = []
	let gate: AuthorizationGate | undefined
	const rebuild = () => {
		const { rules } = compilePermissions(permissionsForAllows(entries))
		gate =
			rules.length === 0
				? undefined
				: new AuthorizationGate(
						{
							enabled: true,
							rules: [...rules],
							allowReadOnlyTools: false,
							denyDangerousPatterns: false,
							logDecisions: false,
						},
						NOOP_LOGGER,
					)
	}
	const allowed = (call: AuthorizationPredicateCall): boolean => {
		// Leaving the sandbox is asked every time (the call's escalation); this is
		// the same refusal at the rule, for a caller that never computed one.
		if (isRecord(call.toolInput) && call.toolInput.dangerously_disable_sandbox === true)
			return false
		const result = gate?.evaluate(call)
		return result !== undefined && result.matchedRule !== null && result.decision === 'allow'
	}
	return {
		add(allows) {
			const fresh = allows.filter(
				(allow) => !entries.some((existing) => sameAllow(existing, allow)),
			)
			// Written even when already held in memory: the file is the memory
			// that survives, and a rule deleted from it should come back when asked for.
			entries.push(...fresh)
			if (fresh.length > 0) rebuild()
			const cwd = typeof options.cwd === 'function' ? options.cwd() : options.cwd
			if (cwd === undefined) return undefined
			const write = (options.persist ?? writeLocalAllows)(cwd, permissionsForAllows(allows))
			if (write.error !== undefined) {
				cliLogger().warn('Could not save a remembered answer', {
					'namzu.config.local.path': write.path,
					'namzu.config.local.error': write.error,
				})
				return `Could not save this answer to ${LOCAL_CONFIG_FILE}: ${write.error}. It holds for this session only.`
			}
			void (options.keepIgnored ?? ensureLocalConfigIgnored)(cwd).then(logIgnoreOutcome)
			return undefined
		},
		list: () => [...entries],
		rule: {
			type: 'predicate',
			description: 'allowed by an answer at a prompt',
			decide: (call) => (allowed(call) ? 'allow' : null),
		},
	}
}
