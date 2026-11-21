/**
 * What a "don't ask again" answer remembers.
 *
 * Each answer is offered as a permission suggestion that "yes"
 * applies and that is written to the project's local settings file. This is the
 * Namzu side of that: an allow the operator gave at a prompt, written to the
 * project's `.namzu/settings.local.json` (see `local-settings.ts`), where the
 * next session reads it back as the local layer of the config cascade, and held
 * in memory as well so it applies to the very next call. It is held in memory
 * only, and the answer says so, when the folder is not trusted (its local file
 * is not read there), when git tracks the local file, or when the rule looks
 * like it holds a password or a token (`rule-secrets.ts`). It sits AFTER the
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
	isReadOnlyCommandLine,
	lexShellCommandLine,
	mustAskPerson,
	writesThroughRedirection,
} from '@namzu/sdk'

import { cliLogger } from '../logging.js'
import { withoutCdToCwd } from '../tui/shell-display.js'
import {
	LOCAL_SETTINGS_FILE,
	ensureLocalConfigIgnored,
	logIgnoreOutcome,
	writeLocalAllows,
} from './local-settings.js'
import { ruleLooksSecret } from './rule-secrets.js'
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
	readonly authorization?: { readonly explicitReview?: boolean; readonly askRule?: boolean }
	readonly hookPermission?: { readonly decision?: string }
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
	return mustAskPerson(call) || call.isDestructive === true
}

/** The kernel's own test for a call that exists to put a question to a person. */
export { mustAskPerson }

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
 * The meaningful commands a line runs, when every one of them is a plain
 * command: the line parses completely, nothing in it is read at run time, and
 * no command writes a file through a redirection (`2>&1` and `> /dev/null`
 * are not writes). A command that only reads (`tail`, `head`, `grep`, `wc`)
 * is left out when something else is run with it, because it needs no rule:
 * `npm test 2>&1 | tail -20` is the one command `npm test`.
 */
function plainCommands(line: string): readonly string[] | undefined {
	const lexed = lexShellCommandLine(line, { dialect: 'bash' })
	if (!lexed.complete || lexed.opaque || lexed.commands.length === 0) return undefined
	if (lexed.compoundWords.length > 0) return undefined
	if (writesThroughRedirection(line, 'bash')) return undefined
	const meaningful: string[] = []
	const readers: string[] = []
	for (const command of lexed.commands) {
		if (command.origin !== 'line') return undefined
		// What the command is, without the redirections that do nothing.
		const text =
			command.redirections.length > 0
				? command.words.map((word) => word.text).join(' ')
				: command.text.trim()
		if (text === '') return undefined
		// `cd` stays: it is remembered as the exact move, never as a wider prefix.
		const reads =
			programName(text.split(/\s+/)[0] ?? '') !== 'cd' &&
			isReadOnlyCommandLine(command.text.trim(), 'bash')
		;(reads ? readers : meaningful).push(text)
	}
	// A line of nothing but readers keeps them: they are all it has to remember.
	const out = meaningful.length > 0 ? meaningful : readers
	return out.length > 0 ? out : undefined
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
export function describeAllows(allows: readonly SessionAllow[], cwd?: string): string {
	// The `cd <the working folder>` a line starts with is remembered too, since the rules cover a
	// line only together, but it is not what the person is saying yes to: it is left out of the
	// words while anything else remains.
	const goesNowhere = (allow: SessionAllow): boolean =>
		cwd !== undefined &&
		allow.kind === 'command' &&
		withoutCdToCwd(`${allow.command} && :`, cwd) !== `${allow.command} && :`
	const shown = allows.some((allow) => !goesNowhere(allow))
		? allows.filter((allow) => !goesNowhere(allow))
		: allows
	const parts = shown.map((allow) => {
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
	/** Withdraw cached answers after the operator replaces the saved local rules. */
	clear(): void
	/** One kernel rule that consults the store at every call. */
	readonly rule: AuthorizationRule
}

export interface SessionAllowsOptions {
	/** The folder whose `.namzu/settings.local.json` receives the answers. Absent: memory only. */
	readonly cwd?: string | (() => string | undefined)
	/**
	 * Whether that folder is trusted. An untrusted folder's local file is not
	 * read, so an answer there is held for the session only. Absent: trusted.
	 */
	readonly trusted?: () => boolean
	/** Overridable for tests. */
	readonly persist?: typeof writeLocalAllows
	readonly keepIgnored?: typeof ensureLocalConfigIgnored
}

/** The text a rule carries, as `<tool> <pattern>`, for the secret check. */
function allowText(allow: SessionAllow): string | undefined {
	switch (allow.kind) {
		case 'command':
			return allow.command
		case 'prefix':
			return `${allow.prefix} *`
		case 'host':
			return allow.host
		case 'tool':
			return undefined
	}
}

/** Whether an answer's rule looks like it holds a password or a token. */
export function allowHoldsSecret(allow: SessionAllow): boolean {
	return ruleLooksSecret(allow.tool, allowText(allow))
}

const UNTRUSTED_FOLDER =
	'This folder is not trusted, so the answer was not saved to its settings; it holds for this conversation only.'
const SECRET_RULE =
	'That rule looks like it holds a password or a token, so it was not saved to a file; it holds for this conversation only.'

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
			if (options.trusted !== undefined && !options.trusted()) return UNTRUSTED_FOLDER
			const saved = allows.filter((allow) => !allowHoldsSecret(allow))
			const notes: string[] = saved.length < allows.length ? [SECRET_RULE] : []
			if (saved.length === 0) return notes.join(' ')
			const write = (options.persist ?? writeLocalAllows)(cwd, permissionsForAllows(saved))
			if (write.sentence !== undefined) notes.push(write.sentence)
			else if (write.error !== undefined) {
				cliLogger().warn('Could not save a remembered answer', {
					'namzu.config.local.path': write.path,
					'namzu.config.local.error': write.error,
				})
				notes.push(
					`Could not save this answer to ${LOCAL_SETTINGS_FILE}: ${write.error}. It holds for this session only.`,
				)
			} else void (options.keepIgnored ?? ensureLocalConfigIgnored)(cwd).then(logIgnoreOutcome)
			return notes.length > 0 ? notes.join(' ') : undefined
		},
		list: () => [...entries],
		clear() {
			entries.length = 0
			rebuild()
		},
		rule: {
			type: 'predicate',
			description: 'allowed by an answer at a prompt',
			decide: (call) => (allowed(call) ? 'allow' : null),
		},
	}
}
