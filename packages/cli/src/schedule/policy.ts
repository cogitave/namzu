/**
 * What a scheduled run may do, compiled to the kernel's rules.
 *
 * Order is the meaning (first match wins), and it is:
 *
 * 1. the kernel's dangerous-command floor (`gateFor` puts it first; it DENIES,
 *    it never parks — an operator cannot approve `rm -rf /` later);
 * 2. the scheduled-run floor: no command that stops, disables or removes the
 *    scheduler service, no `schedule` subcommand but a read-only one, and no
 *    tool argument naming `NAMZU_HOME` by its path, `~/…`, `$HOME/…` or
 *    `$NAMZU_HOME` (a run cannot rewrite its own job, its history, the
 *    daemon's endpoint token or the credentials beside them);
 * 3. every `deny` any config file wrote — user, project, managed — each file
 *    read on its own, so a project's allow cannot hide a user's deny;
 * 4. the job's own rules. ALLOWS COME ONLY FROM HERE: no config file can widen
 *    a job the operator confirmed;
 * 5. `unmatched`, as the review mode: `park` → `prompt` with every batch held
 *    for the operator, `deny` → `strict`, `allow` → `auto` (a path outside the
 *    roots and a sandbox escape still hold).
 *
 * The scheduled-run floor is best effort, like any pattern over a shell
 * command line. The control that does not depend on patterns is elsewhere: a
 * job folder may not contain `NAMZU_HOME`, and a job file edited behind the
 * CLI's back is held until someone confirms it.
 */

import { homedir } from 'node:os'
import type { AuthorizationRule } from '@namzu/sdk'
import type { PermissionLayer } from '../config/load.js'
import type { PermissionMode } from '../permissions/mode.js'
import {
	type CompileDiagnostic,
	type PermissionEffect,
	type PermissionsConfig,
	type ToolPermission,
	compilePermissions,
	isPermissionEffect,
} from '../permissions/rules.js'
import type { SchedulePermissionSet } from './types.js'

export type PresetName = 'read-only' | 'edit-in-folder'

const NETWORK_TOOLS = ['web_fetch', 'web_search'] as const
const WRITE_TOOLS = ['write', 'edit', 'bash'] as const

const READ_ONLY: PermissionsConfig = {
	read: 'allow',
	glob: 'allow',
	grep: 'allow',
	ls: 'allow',
	write: 'deny',
	edit: 'deny',
	bash: 'deny',
	web_fetch: 'deny',
	web_search: 'deny',
}

/**
 * The presets, expanded at creation and stored verbatim, so a later change to
 * what a preset means never changes an existing job. Neither reaches the
 * network: web access is opt-in, rule by rule.
 */
export const PRESETS: Readonly<
	Record<PresetName, { readonly rules: PermissionsConfig; readonly unmatched: 'park' | 'deny' }>
> = {
	'read-only': { rules: READ_ONLY, unmatched: 'deny' },
	'edit-in-folder': {
		rules: { ...READ_ONLY, write: 'allow', edit: 'allow', bash: 'ask' },
		unmatched: 'park',
	},
}

export function isPresetName(value: unknown): value is PresetName {
	return value === 'read-only' || value === 'edit-in-folder'
}

export interface PermissionInput {
	readonly preset?: PresetName
	readonly rules?: PermissionsConfig
	readonly unmatched?: 'park' | 'deny' | 'allow'
	readonly execution?: 'host' | 'sandbox'
	readonly additionalDirectories?: readonly string[]
}

/**
 * A preset and/or explicit rules, into the set a job stores. Explicit rules
 * override the preset's per tool. `unmatched` must come from somewhere — the
 * preset or the caller — and `execution` defaults to `host` (the CLI's
 * boundary) but is always written.
 */
export function expandPermissions(input: PermissionInput): SchedulePermissionSet {
	if (!input.preset && !input.rules) {
		throw new Error(
			'A permission set needs a preset (read-only, edit-in-folder) or rules; there is no default.',
		)
	}
	const preset = input.preset ? PRESETS[input.preset] : undefined
	const unmatched = input.unmatched ?? preset?.unmatched
	if (!unmatched) {
		throw new Error('unmatched is required: park (wait for the operator), deny, or allow.')
	}
	const rules = { ...(preset?.rules ?? {}), ...(input.rules ?? {}) }
	const compiled = compilePermissions(rules)
	if (compiled.diagnostics.length > 0) {
		throw new Error(
			`The permission rules do not compile: ${compiled.diagnostics.map(describeDiagnostic).join('; ')}`,
		)
	}
	return {
		unmatched,
		execution: input.execution ?? 'host',
		rules,
		...(input.additionalDirectories && input.additionalDirectories.length > 0
			? { additionalDirectories: [...input.additionalDirectories] }
			: {}),
		preset: input.preset && !input.rules ? input.preset : 'custom',
	}
}

function describeDiagnostic(d: CompileDiagnostic): string {
	return `${d.pattern ? `${d.tool}."${d.pattern}"` : d.tool}: ${d.message}`
}

function effectsOf(permission: ToolPermission | undefined): PermissionEffect[] {
	if (permission === undefined) return []
	if (isPermissionEffect(permission)) return [permission]
	return Object.values(permission).filter(isPermissionEffect)
}

/** Whether the set lets a run reach the network. */
export function allowsNetwork(set: SchedulePermissionSet): boolean {
	return NETWORK_TOOLS.some((t) => effectsOf(set.rules[t]).some((e) => e !== 'deny'))
}

/** Whether a run under this set can change the folder (write, edit, bash, or an unmatched call). */
export function allowsWrites(set: SchedulePermissionSet): boolean {
	if (set.unmatched !== 'deny') return true
	return WRITE_TOOLS.some((t) => effectsOf(set.rules[t]).some((e) => e !== 'deny'))
}

/** Only the `deny` entries of one config file's table. */
export function denialsOf(table: PermissionsConfig): PermissionsConfig {
	const out: Record<string, ToolPermission> = {}
	for (const [tool, permission] of Object.entries(table)) {
		if (permission === 'deny') out[tool] = 'deny'
		else if (permission && typeof permission === 'object') {
			const denied = Object.fromEntries(
				Object.entries(permission).filter(([, effect]) => effect === 'deny'),
			) as Record<string, PermissionEffect>
			if (Object.keys(denied).length > 0) out[tool] = denied
		}
	}
	return out
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `abc` → `[aA][bB][cC]`: the gate compiles patterns without flags. */
function caseless(text: string): string {
	return text.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)
}

/**
 * What the shell drops between two letters of a word: quotes, a backslash, the
 * `$` that opens `$'…'` or `$"…"`, and the newline of a line continuation
 * (`\` at the end of a line). A bare `$` or a bare newline is taken too:
 * broader, never narrower.
 */
const DROPPED = `["'\\\\$\\n]*`

/**
 * {@link caseless}, and also matched when the shell would read it the same
 * with quotes or backslashes inside: `"schedule"`, `sch''edule`, `n\amzu`,
 * `sch$'e'dule` (ANSI-C quoting), `sch$"e"dule` (locale quoting) and
 * `sche\<newline>dule` (a line continuation). Not a parser — a variable or an
 * `eval` still gets past it; this is a tripwire, and the tampered-job hold and
 * the confirmation are the others.
 */
function loose(text: string): string {
	return [...text].map((c) => caseless(c)).join(DROPPED)
}

/**
 * Space between words, with the quotes (`'`, `"`, `$'`, `$"`) that may close
 * and open around it and a line continuation (`\s` takes its newline).
 */
const GAP = `[\\s"'\\\\$]+`

/**
 * One character of the same simple command: `;`, `&`, `|` and a newline end
 * one, a line continuation does not.
 */
const IN_COMMAND = String.raw`(?:\\\n|[^;&|\n])`
/** Where a simple command starts: the text's start, or a `;`, `&`, `|` or newline that ends the one before. */
const COMMAND_START = String.raw`(?:^|[;&|]|(?<!\\)\n)`

/**
 * `words` in this order anywhere in the text, newlines included. Each but the
 * last is taken at its first place after the one before, inside a lookahead
 * the match cannot backtrack into, and only from the text's start: `a.*b.*c`
 * would try every `a` and, for each, every `b`, which is quadratic on a
 * command that repeats `a`. Taking the first of each loses no match. `words`
 * must not capture.
 */
function inOrder(...words: string[]): string {
	const last = words.at(-1) ?? ''
	// `[^]` is any character, a newline included, in fewer characters than
	// `[\s\S]`: the gate's limit is tight for the launchctl rules.
	const atomic = words.slice(0, -1).map((word, i) => `(?=([^]*?${word}))\\${i + 1}`)
	return `^${atomic.join('')}[^]*?${last}`
}

/**
 * `word` at its first place in a simple command, and the rest of that command
 * after it. Every other `word` of the command comes after the first, so a
 * match from a later one is a match from the first too; trying each would be
 * quadratic on a command that repeats `word`. `word` must not capture.
 */
function firstInCommand(word: string): string {
	return `${COMMAND_START}(?=(${IN_COMMAND}*?${word}))\\1${IN_COMMAND}*`
}

/**
 * What the shell drops in a path, as it appears in JSON text: `'`, `"`, the
 * `$` that opens ANSI-C (`$'…'`) or locale (`$"…"`) quoting, and a newline
 * (`\\n`). A line continuation is a backslash (`\\\\`, which {@link SEP} and
 * {@link INNER_QUOTES} take) and then that newline; a bare newline is taken
 * too, broader, never narrower.
 */
const QUOTE = String.raw`\$?(?:\\"|')|\\n`
/**
 * Quotes the shell drops in a path. No bare backslash: next to {@link SEP},
 * which takes one, a run of backslashes would backtrack polynomially.
 */
const QUOTES = `(?:${QUOTE})*`
/**
 * A path separator as it appears in JSON text (`\\` doubled), repeated, with
 * `./` or an empty quoted segment (`''`, `""`, `'.'`) between, as the shell
 * reads it: `/home/u/''/.namzu` is `/home/u//.namzu`. What comes between two
 * separators is never empty: `[/\\]+(?:[/\\]+)*` backtracks exponentially.
 */
const SEP = String.raw`[/\\]+(?:(?:${QUOTES}\.${QUOTES}|(?:${QUOTE})+)[/\\]+)*`
/**
 * Where a leading {@link SEP} may start: at a `/` or a real backslash (not the
 * one JSON puts before a quote), and not where a separator and what
 * {@link SEP} allows after one come just before. A match starting there would
 * also start at that earlier separator, and trying every start inside a long
 * run (`/./././…`, `/''/''/…`, `\\\\…`) backtracks quadratically.
 */
const LEAD = String.raw`(?=/|\\(?!"))(?<![/\\]${QUOTES}(?:\.${QUOTES})?)${SEP}`
/**
 * Inside a segment's name, also an escaping backslash (`.nam\zu`), which JSON
 * doubles, and so a line continuation (`.nam\<newline>zu`).
 */
const INNER_QUOTES = String.raw`(?:${QUOTE}|\\\\)*`
/** Not followed by more of a path segment's name: `/tmp/x` does not match `/tmp/x2`. */
const SEGMENT_END = '(?![A-Za-z0-9._-])'
/** The gate refuses a longer pattern (`MAX_CUSTOM_PATTERN_LENGTH`). */
const MAX_PATTERN = 500

/**
 * `$NAME` or `${NAME`, as it appears in JSON text, with a line continuation
 * (`\\\\\\n` there) anywhere in it: the shell drops those before it expands.
 */
const variable = (name: string) =>
	[String.raw`\$`, String.raw`\{?`, ...name].join(String.raw`(?:\\\\\\n)*`)

const jsonText = (text: string) => escapeRegExp(JSON.stringify(text).slice(1, -1))

/**
 * A path segment as the shell reads it, in any letter case (macOS and a
 * Windows drive do not tell `.NAMZU` from `.namzu`), with quotes around it
 * (`".namzu"`, `'.namzu'`). `inner` also reads quotes anywhere inside it
 * (`.nam''zu`, `.nam"z"u`) and a backslash escaping any of its characters but
 * the first (`.nam\zu`); that costs about fifteen characters a letter.
 */
const segment = (name: string, inner: boolean) =>
	`${QUOTES}${[...name].map((c) => caseless(jsonText(c))).join(inner ? INNER_QUOTES : '')}${QUOTES}`

/**
 * `names` joined by {@link SEP} within `budget` characters, or null. With
 * `inner`, every segment is read with quotes inside it; without, every segment
 * is read with quotes around it and then, from the last back, as many as fit
 * are also read with quotes inside.
 */
function segments(names: readonly string[], budget: number, inner: boolean): string | null {
	const loose = names.map(() => inner)
	const build = () => names.map((name, i) => segment(name, loose[i] ?? false)).join(SEP)
	let text = build()
	if (text.length > budget) return null
	for (let i = names.length - 1; !inner && i >= 0; i--) {
		loose[i] = true
		const wider = build()
		if (wider.length > budget) {
			loose[i] = false
			break
		}
		text = wider
	}
	return text
}

/**
 * The ways a tool argument names `namzuHome`: its absolute path (with
 * doubled slashes, `./` or `''` in it), `~/…`, `$HOME/…` or `${HOME}/…` when
 * it is under the user's home, and `$NAMZU_HOME`, in any letter case and with
 * shell quotes anywhere in the path's segments. Not `..`, not a relative path
 * after a `cd`, not a variable, a glob (`~/.namz*`) or a brace expansion
 * (`~/.{namzu,x}`): a pattern cannot resolve those. Every pattern fits the
 * gate's limit of {@link MAX_PATTERN} characters.
 */
export function namzuHomePatterns(namzuHome: string, userHome: string): string[] {
	const split = (path: string) => path.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.')
	const home = split(namzuHome)
	const rooted = /^[\\/]/.test(namzuHome)
	const trailing = (from: number, inner: boolean): string | null => {
		const lead = rooted || from > 0 ? LEAD : ''
		const body = segments(home.slice(from), MAX_PATTERN - lead.length - SEGMENT_END.length, inner)
		return body === null ? null : `${lead}${body}${SEGMENT_END}`
	}
	// A home too long to fit is matched by as many of its trailing segments
	// as do: broader, never narrower. A last segment too long to read with
	// quotes inside it on its own leaves the whole path, read with quotes
	// around its segments and inside as many trailing ones as fit; a name
	// longer still is matched by the start of it.
	let absolute: string | null = null
	for (const inner of [true, false])
		for (let from = 0; absolute === null && from < home.length; from++)
			absolute = trailing(from, inner)
	if (absolute === null) {
		let name = home.at(-1) ?? ''
		const tail = () => `${LEAD}${QUOTES}${caseless(jsonText(name))}`
		while (name.length > 1 && tail().length > MAX_PATTERN) name = name.slice(0, -1)
		absolute = tail()
	}
	const patterns = [absolute, `${variable('NAMZU_HOME')}\\b`]
	const user = split(userHome)
	if (user.length > 0 && home.length > user.length && user.every((name, i) => name === home[i])) {
		const prefix = `(?:~[A-Za-z0-9._-]*|${variable('HOME')}\\b\\}?)${QUOTES}${SEP}`
		const budget = MAX_PATTERN - prefix.length - SEGMENT_END.length
		const below = home.slice(user.length)
		const body = segments(below, budget, true) ?? segments(below, budget, false)
		// Too long even so, `~/…` is left to the absolute pattern's trailing segments.
		if (body !== null) patterns.push(`${prefix}${body}${SEGMENT_END}`)
	}
	return patterns
}

/** Scheduler verbs a run may use: they read, they change nothing. */
const READ_ONLY_VERBS = ['list', 'show', 'status', 'history', 'logs']

/** Rules that keep a scheduled run away from its own scheduler and its own records. */
export function scheduledRunFloor(
	namzuHome: string,
	userHome: string = homedir(),
): AuthorizationRule[] {
	// One rule per verb: each word spelled loosely is long, and the gate caps
	// a pattern at 500 characters (and refuses a longer one).
	const bash = (pattern: string): AuthorizationRule => ({
		type: 'argument_pattern',
		toolNames: ['bash'],
		argument: 'command',
		pattern,
		decision: 'deny',
	})
	// Any `schedule` subcommand but a read-only one, however the CLI is
	// reached: `namzu`, `npx @namzu/cli`, `node …/@namzu/cli/dist/bin.js`,
	// `node packages/cli/dist/bin.js`; options may come between. The verb
	// must start right after the space and its quotes, so `"list"` cannot be
	// read as a space followed by a verb `"list"`. Within one command of a
	// list: `;`, `&`, `|` and a newline end the search, a line continuation
	// does not.
	const readOnly = READ_ONLY_VERBS.map(caseless).join('|')
	const scheduleVerb = `\\b${loose('schedule')}${GAP}(?![\\s"'\\\\$])(?!(?:${readOnly})(?![A-Za-z0-9_-]))`
	return [
		...['stop', 'disable', 'mask', 'edit', 'kill', 'revert'].map((verb) =>
			bash(inOrder(`${loose('systemctl')}\\b`, `\\b${loose(verb)}\\b`, loose('namzu-scheduler'))),
		),
		...['bootout', 'unload', 'remove', 'disable'].map((verb) =>
			bash(
				inOrder(`${loose('launchctl')}\\b`, `\\b${loose(verb)}\\b`, loose('com.namzu.scheduler')),
			),
		),
		bash(
			inOrder(
				`${loose('schtasks')}(?:\\.${loose('exe')})?\\b`,
				`/(?:${loose('delete')}|${loose('change')}|${loose('end')})\\b`,
				loose('namzu'),
			),
		),
		bash(inOrder(`\\b(?:${loose('pkill')}|${loose('killall')})\\b`, loose('namzu'))),
		bash(`${firstInCommand(`\\b${loose('namzu')}\\b`)}${scheduleVerb}`),
		bash(
			`${firstInCommand(`\\b${loose('bin')}${DROPPED}\\.${DROPPED}${loose('js')}\\b`)}${scheduleVerb}`,
		),
		...namzuHomePatterns(namzuHome, userHome).map(
			(pattern): AuthorizationRule => ({
				type: 'custom_pattern',
				pattern,
				target: 'args',
				decision: 'deny',
			}),
		),
	]
}

export interface CompiledJobPolicy {
	readonly rules: readonly AuthorizationRule[]
	/** Rule lines that did not compile, from the job or a config file. A job one is refused at creation. */
	readonly diagnostics: readonly string[]
	readonly mode: PermissionMode
	readonly network: boolean
	readonly writes: boolean
	/** The effective policy in words, one line per rule, for a confirmation or `show`. */
	readonly lines: readonly string[]
}

function modeFor(unmatched: SchedulePermissionSet['unmatched']): PermissionMode {
	return unmatched === 'park' ? 'prompt' : unmatched === 'deny' ? 'strict' : 'auto'
}

function lineFor(tool: string, permission: ToolPermission): string[] {
	if (isPermissionEffect(permission)) return [`${tool}: ${permission}`]
	return Object.entries(permission).map(([pattern, effect]) => `${tool} "${pattern}": ${effect}`)
}

/** Compile a job's permission set against every config file's denies. */
export function compileJobPolicy(
	set: SchedulePermissionSet,
	options: { readonly layers: readonly PermissionLayer[]; readonly namzuHome: string },
): CompiledJobPolicy {
	const diagnostics: string[] = []
	const configDenies: AuthorizationRule[] = []
	const denyLines: string[] = []
	for (const layer of options.layers) {
		const denied = denialsOf(layer.permissions)
		const compiled = compilePermissions(denied)
		configDenies.push(...compiled.rules)
		for (const d of compiled.diagnostics)
			diagnostics.push(`${layer.path}: ${describeDiagnostic(d)}`)
		for (const [tool, permission] of Object.entries(denied))
			for (const line of lineFor(tool, permission)) denyLines.push(`${line} (from ${layer.path})`)
	}
	const own = compilePermissions(set.rules)
	for (const d of own.diagnostics) diagnostics.push(`job: ${describeDiagnostic(d)}`)
	// Web tools are denied by name unless the job itself lets them run: the
	// gate's read-only default would otherwise approve a fetch.
	const networkDenied = NETWORK_TOOLS.filter((t) => set.rules[t] === undefined)
	const rules: AuthorizationRule[] = [
		...scheduledRunFloor(options.namzuHome),
		...configDenies,
		...own.rules,
		...(networkDenied.length > 0
			? [{ type: 'deny_by_name', toolNames: [...networkDenied] } as AuthorizationRule]
			: []),
	]
	const lines = [
		'dangerous commands (rm -rf /, mkfs, curl | sh, sudo …): deny, always',
		`the scheduler's commands (but ${READ_ONLY_VERBS.join(', ')}), and anything naming NAMZU_HOME: deny`,
		...denyLines,
		...Object.entries(set.rules).flatMap(([tool, permission]) => lineFor(tool, permission)),
		`anything else: ${set.unmatched === 'park' ? 'wait for the operator' : set.unmatched === 'deny' ? 'deny' : 'run without asking'}`,
	]
	return {
		rules,
		diagnostics,
		mode: modeFor(set.unmatched),
		network: allowsNetwork(set),
		writes: allowsWrites(set),
		lines,
	}
}
