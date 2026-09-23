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
 * {@link caseless}, and also matched when the shell would read it the same
 * with quotes or backslashes inside: `"schedule"`, `sch''edule`, `n\amzu`.
 * Not a parser — a variable or an `eval` still gets past it; this is a
 * tripwire, and the tampered-job hold and the confirmation are the others.
 */
function loose(text: string): string {
	return [...text].map((c) => caseless(c)).join(`["'\\\\]*`)
}

/** Space between words, with the quotes that may close and open around it. */
const GAP = `[\\s"'\\\\]+`

/** A path separator as it appears in JSON text (`\\` doubled), repeated or with `./` between, as the shell reads it. */
const SEP = String.raw`[/\\]+(?:\.[/\\]+)*`
/**
 * Quotes the shell drops in a path, as they appear in JSON text. No bare
 * backslash: next to {@link SEP}, which takes one, a run of backslashes would
 * backtrack polynomially.
 */
const QUOTES = String.raw`(?:\\"|')*`
/** Inside a segment's name, also an escaping backslash (`.nam\zu`), which JSON doubles. */
const INNER_QUOTES = String.raw`(?:\\["\\]|')*`
/** Not followed by more of a path segment's name: `/tmp/x` does not match `/tmp/x2`. */
const SEGMENT_END = '(?![A-Za-z0-9._-])'
/** The gate refuses a longer pattern (`MAX_CUSTOM_PATTERN_LENGTH`). */
const MAX_PATTERN = 500

const jsonText = (text: string) => escapeRegExp(JSON.stringify(text).slice(1, -1))

/**
 * A path segment as the shell reads it: quotes may open and close around it
 * and anywhere inside it (`".namzu"`, `'.namzu'`, `.nam''zu`, `.nam"z"u`), and
 * a backslash may escape any of its characters but the first (`.nam\zu`).
 */
const segment = (name: string) => `${QUOTES}${[...name].map(jsonText).join(INNER_QUOTES)}${QUOTES}`

/**
 * The ways a tool argument names `namzuHome`: its absolute path (with
 * doubled slashes or `./` in it), `~/…`, `$HOME/…` or `${HOME}/…` when it is
 * under the user's home, and `$NAMZU_HOME`, each with shell quotes anywhere in
 * the path's segments. Not `..`, not a relative path after a `cd`, not a
 * variable, a glob (`~/.namz*`) or a brace expansion (`~/.{namzu,x}`): a
 * pattern cannot resolve those.
 */
export function namzuHomePatterns(namzuHome: string, userHome: string): string[] {
	const split = (path: string) => path.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.')
	const home = split(namzuHome)
	// A home so deep the whole path does not fit is matched by as many of its
	// trailing segments as do: broader, never narrower.
	// The leading separator starts only where a run of separators does: tried
	// at every backslash of a long run, it would backtrack quadratically.
	const lead = `(?<![/\\\\])${SEP}`
	let absolute = `${/^[\\/]/.test(namzuHome) ? lead : ''}${home.map(segment).join(SEP)}${SEGMENT_END}`
	for (let from = 1; absolute.length > MAX_PATTERN && from < home.length; from++)
		absolute = `${lead}${home.slice(from).map(segment).join(SEP)}${SEGMENT_END}`
	const patterns = [absolute, String.raw`\$\{?NAMZU_HOME\b`]
	const user = split(userHome)
	if (user.length > 0 && home.length > user.length && user.every((name, i) => name === home[i])) {
		const below = home.slice(user.length).map(segment).join(SEP)
		const relative = `(?:~[A-Za-z0-9._-]*|\\$\\{?HOME\\b\\}?)${QUOTES}${SEP}${below}${SEGMENT_END}`
		if (relative.length <= MAX_PATTERN) patterns.push(relative)
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
	// list: `;`, `&` and `|` end the search.
	const readOnly = READ_ONLY_VERBS.map(caseless).join('|')
	const scheduleVerb = `[^;&|\\n]*\\b${loose('schedule')}${GAP}(?![\\s"'\\\\])(?!(?:${readOnly})(?![A-Za-z0-9_-]))`
	return [
		...['stop', 'disable', 'mask', 'edit', 'kill', 'revert'].map((verb) =>
			bash(`${loose('systemctl')}\\b.*\\b${loose(verb)}\\b.*${loose('namzu-scheduler')}`),
		),
		...['bootout', 'unload', 'remove', 'disable'].map((verb) =>
			bash(`${loose('launchctl')}\\b.*\\b${loose(verb)}\\b.*${loose('com.namzu.scheduler')}`),
		),
		bash(
			`${loose('schtasks')}(\\.${loose('exe')})?\\b.*/(${loose('delete')}|${loose('change')}|${loose('end')})\\b.*${loose('namzu')}`,
		),
		bash(`\\b(${loose('pkill')}|${loose('killall')})\\b.*${loose('namzu')}`),
		bash(`\\b${loose('namzu')}\\b${scheduleVerb}`),
		bash(`\\b${loose('bin')}["'\\\\]*\\.["'\\\\]*${loose('js')}\\b${scheduleVerb}`),
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
