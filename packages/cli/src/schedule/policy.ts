/**
 * What a scheduled run may do, compiled to the kernel's rules.
 *
 * Order is the meaning (first match wins), and it is:
 *
 * 1. the kernel's dangerous-command floor (`gateFor` puts it first; it DENIES,
 *    it never parks — an operator cannot approve `rm -rf /` later);
 * 2. the scheduled-run floor (`floor.ts`, one `predicate` rule): no command
 *    that stops, disables or removes the scheduler service, no `schedule`
 *    subcommand but a read-only one, and nothing that resolves into
 *    `NAMZU_HOME` (a run cannot rewrite its own job, its history, the
 *    daemon's endpoint token or the credentials beside them). A command line
 *    is decided on the words bash will pass, as the SDK's lexer reads them;
 * 3. every `deny` any config file wrote — user, project, managed — each file
 *    read on its own, so a project's allow cannot hide a user's deny;
 * 4. the job's own rules. ALLOWS COME ONLY FROM HERE: no config file can widen
 *    a job the operator confirmed;
 * 5. `unmatched`, as the review mode: `park` → `prompt` with every batch held
 *    for the operator, `deny` → `strict`, `allow` → `auto` (a path outside the
 *    roots and a sandbox escape still hold).
 *
 * The scheduled-run floor reads a command line the way bash does (see
 * `floor.ts`), but it reads a line, not the programs it starts: a script that
 * builds the command from its own data is beyond it. The controls that do not
 * depend on reading are elsewhere: a job folder may not contain `NAMZU_HOME`,
 * and a job file edited behind the CLI's back is held until someone confirms
 * it.
 */

import { homedir } from 'node:os'
import {
	type AuthorizationRule,
	BROWSER_ACT_TOOL_NAME,
	BROWSER_TOOL_NAME,
	type ScheduleBrowserGrant,
	type ScheduleBrowserSiteLevel,
} from '@namzu/sdk'
import { isBrowserProfileName } from '../browser/control.js'
import type { PermissionLayer } from '../config/load.js'
import {
	type BrowserSiteLevel,
	canonicalBrowserSiteKey,
	compileBrowserSites,
} from '../permissions/browser-sites.js'
import type { PermissionMode } from '../permissions/mode.js'
import {
	type CompileDiagnostic,
	type PermissionEffect,
	type PermissionsConfig,
	type ToolPermission,
	compilePermissions,
	isPermissionEffect,
} from '../permissions/rules.js'
import { READ_ONLY_VERBS, isFloorRule, scheduledRunFloorRule } from './floor.js'
import type { SchedulePermissionSet } from './types.js'

export type PresetName = 'read-only' | 'edit-in-folder'

const NETWORK_TOOLS = ['web_fetch', 'web_search'] as const
/** The browser tools: reached only through a job's browser grant, never through its rules. */
const BROWSER_TOOLS = [BROWSER_TOOL_NAME, BROWSER_ACT_TOOL_NAME] as const
const GRANT_LEVELS: readonly ScheduleBrowserSiteLevel[] = ['read', 'ask', 'act']
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
	/** A browser grant as written: site keys in any spelling, levels unchecked. */
	readonly browser?: {
		readonly profile: string
		readonly sites: Readonly<Record<string, string>>
		readonly headed?: boolean
	}
}

/**
 * A browser grant as a job stores it: a profile name, at least one site,
 * each key canonical and none of them `*`, each level `read`, `ask` or
 * `act`. `ask` parks the call for the operator, so it needs
 * `unmatched: park`: under `deny` every ask would be refused and under
 * `allow` approved without anyone seeing it.
 */
export function checkBrowserGrant(
	input: NonNullable<PermissionInput['browser']>,
	unmatched: SchedulePermissionSet['unmatched'],
): ScheduleBrowserGrant {
	if (!isBrowserProfileName(input.profile)) {
		throw new Error(
			`"${input.profile}" is not a browser profile name: lowercase letters, digits and single hyphens.`,
		)
	}
	const entries = Object.entries(input.sites)
	if (entries.length === 0) {
		throw new Error(
			'A browser grant needs at least one site, e.g. --browser-site https://github.com=read.',
		)
	}
	const sites: Record<string, ScheduleBrowserSiteLevel> = {}
	for (const [raw, level] of entries) {
		if (raw.trim() === '*') {
			throw new Error(
				'A scheduled job cannot grant every site ("*"); every site it does not list is denied. List each site.',
			)
		}
		if (!(GRANT_LEVELS as readonly string[]).includes(level)) {
			throw new Error(`browser site ${raw}: "${level}" is not read, ask or act.`)
		}
		const key = canonicalBrowserSiteKey(raw)
		if (!key.ok) throw new Error(`browser site ${raw}: ${key.reason}`)
		const existing = sites[key.key]
		if (existing !== undefined && existing !== level) {
			throw new Error(`browser site ${key.key} is listed twice, as ${existing} and ${level}.`)
		}
		sites[key.key] = level as ScheduleBrowserSiteLevel
	}
	if (unmatched !== 'park' && Object.values(sites).includes('ask')) {
		throw new Error(
			`A browser site at "ask" waits for you, which needs unmatched: park; with ${unmatched} it would be ${unmatched === 'deny' ? 'refused every time' : 'approved without asking'}. Use read or act, or --unmatched park.`,
		)
	}
	return {
		profile: input.profile,
		sites,
		...(input.headed ? { headed: true } : {}),
	}
}

/**
 * A preset and/or explicit rules, into the set a job stores. Explicit rules
 * override the preset's per tool. `unmatched` must come from somewhere — the
 * preset or the caller — and `execution` defaults to `host` (the CLI's
 * boundary) but is always written.
 */
export function expandPermissions(input: PermissionInput): SchedulePermissionSet {
	if (!input.preset && !input.rules && !input.browser) {
		throw new Error(
			'A permission set needs a preset (read-only, edit-in-folder), rules or a browser grant; there is no default.',
		)
	}
	const named = BROWSER_TOOLS.filter((tool) => input.rules?.[tool] !== undefined)
	if (named.length > 0) {
		throw new Error(
			`The rules name ${named.join(' and ')}; a scheduled job reaches the browser only through a browser grant (--browser <profile> --browser-site <site>=read|ask|act).`,
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
	const browser = input.browser ? checkBrowserGrant(input.browser, unmatched) : undefined
	return {
		unmatched,
		execution: input.execution ?? 'host',
		rules,
		...(input.additionalDirectories && input.additionalDirectories.length > 0
			? { additionalDirectories: [...input.additionalDirectories] }
			: {}),
		preset: input.preset && !input.rules ? input.preset : 'custom',
		...(browser ? { browser } : {}),
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

/** Whether the set lets a run reach the network: a web tool not denied, or a browser grant. */
export function allowsNetwork(set: SchedulePermissionSet): boolean {
	return (
		set.browser !== undefined ||
		NETWORK_TOOLS.some((t) => effectsOf(set.rules[t]).some((e) => e !== 'deny'))
	)
}

/**
 * Whether a run under this set can run a shell command: a `bash` rule that is
 * not `deny`, or, with no `bash` rule, an `unmatched` that is not `deny`.
 */
export function allowsCommands(set: SchedulePermissionSet): boolean {
	const effects = effectsOf(set.rules.bash)
	return effects.length > 0 ? effects.some((e) => e !== 'deny') : set.unmatched !== 'deny'
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

/**
 * Rules that keep a scheduled run away from its own scheduler and its own
 * records: one `predicate` rule, decided on the SDK's reading of each command
 * line (see `floor.ts`). `folders` is where the run's relative paths start.
 */
export function scheduledRunFloor(
	namzuHome: string,
	userHome: string = homedir(),
	folders: readonly string[] = [],
): AuthorizationRule[] {
	return [scheduledRunFloorRule({ namzuHome, userHome, folders })]
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
	options: {
		readonly layers: readonly PermissionLayer[]
		readonly namzuHome: string
		/** The job's folder, where the run's relative paths start. */
		readonly folder?: { readonly path: string; readonly canonical: string }
	},
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
	const siteDenies = options.layers.flatMap((layer) =>
		(layer.browserDenies ?? []).map((site) => ({ site, path: layer.path })),
	)
	const browser = set.browser ? compileBrowserGrant(set.browser, siteDenies) : undefined
	if (browser) diagnostics.push(...browser.diagnostics.map((d) => `job: ${d}`))
	// Web tools are denied by name unless the job itself lets them run: the
	// gate's read-only default would otherwise approve a fetch. The browser
	// tools always end up here: without a grant nothing else decides them,
	// and with one this catches every call its site rules did not.
	const networkDenied = [
		...NETWORK_TOOLS.filter((t) => set.rules[t] === undefined),
		...BROWSER_TOOLS,
	]
	const rules: AuthorizationRule[] = [
		...scheduledRunFloor(
			options.namzuHome,
			homedir(),
			options.folder ? [options.folder.path, options.folder.canonical] : [],
		),
		...configDenies,
		...own.rules,
		...(browser?.rules ?? []),
		{ type: 'deny_by_name', toolNames: [...networkDenied] },
	]
	const lines = [
		'dangerous commands (rm -rf /, mkfs, curl | sh, sudo …): deny, always',
		`the scheduler's commands (but ${READ_ONLY_VERBS.join(', ')}), and anything naming NAMZU_HOME or the browser's profiles: deny`,
		...denyLines,
		...Object.entries(set.rules).flatMap(([tool, permission]) => lineFor(tool, permission)),
		...(set.browser ? browserGrantLines(set.browser, siteDenies) : []),
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

export interface ScriptCheckPolicy {
	/** The scheduled-run floor, exactly as the agent path gets it. */
	readonly floorRules: readonly AuthorizationRule[]
	/**
	 * Only what can ever say `deny` for a script: every config file's deny
	 * rules, and the job's OWN rules narrowed to their `deny` entries.
	 * `allow`/`ask` rules and `unmatched` are never in here — a script is not
	 * a call a model improvises that something needs to allow; it is the
	 * exact, human-confirmed, digest-bound text, and that confirmation is
	 * its allowance. What is here can only narrow it further.
	 */
	readonly denyRules: readonly AuthorizationRule[]
	readonly diagnostics: readonly string[]
}

/**
 * The policy a `script`/`script+agent` job's SCRIPT BODY is checked
 * against — never {@link compileJobPolicy}'s full set, which also carries
 * `allow`/`ask` rules and `unmatched` that exist to referee a model
 * improvising calls one at a time. A script has no such referee: it is
 * fixed text an operator read and confirmed. Requiring an `allow` rule for
 * it to pass duplicates that confirmation with a second, laxer one (a
 * blanket `bash: allow` was the shape this forced), and because a
 * `script+agent` job has only one permission set, that same blanket rule
 * then governed the model's OWN bash calls in the agent phase too. Dropping
 * `allow`/`ask`/`unmatched` from the script's own check removes the reason
 * to ever write one: only `deny` rules (the operator's, or any config
 * file's) and the floor can still refuse a confirmed script.
 *
 * The job's `unmatched`/`rules` (with `allow`/`ask` included) still govern
 * the AGENT phase exactly as {@link compileJobPolicy} always has — this
 * function changes nothing about that path.
 */
export function compileScriptCheckPolicy(
	set: SchedulePermissionSet,
	options: {
		readonly layers: readonly PermissionLayer[]
		readonly namzuHome: string
		readonly folder?: { readonly path: string; readonly canonical: string }
	},
): ScriptCheckPolicy {
	const diagnostics: string[] = []
	const configDenies: AuthorizationRule[] = []
	for (const layer of options.layers) {
		const compiled = compilePermissions(denialsOf(layer.permissions))
		configDenies.push(...compiled.rules)
		for (const d of compiled.diagnostics)
			diagnostics.push(`${layer.path}: ${describeDiagnostic(d)}`)
	}
	const ownDenies = compilePermissions(denialsOf(set.rules))
	for (const d of ownDenies.diagnostics) diagnostics.push(`job: ${describeDiagnostic(d)}`)
	return {
		floorRules: scheduledRunFloor(
			options.namzuHome,
			homedir(),
			options.folder ? [options.folder.path, options.folder.canonical] : [],
		),
		denyRules: [...configDenies, ...ownDenies.rules],
		diagnostics,
	}
}

const GRANT_WORDS: Record<ScheduleBrowserSiteLevel, string> = {
	read: 'open and read, never change',
	ask: 'open and read; each change waits for you',
	act: 'open, read and change without asking',
}

/**
 * A job's browser grant as gate rules: the sites it lists at their level,
 * any site a config file denies denied (a grant cannot reopen it), every
 * other site denied, looking at the held page allowed, and `back`,
 * `forward` and `reload` allowed (the host still checks where they land).
 * What none of these decides falls to the trailing deny.
 */
export function compileBrowserGrant(
	grant: ScheduleBrowserGrant,
	denies: readonly { readonly site: string }[] = [],
): {
	readonly rules: AuthorizationRule[]
	readonly diagnostics: readonly string[]
} {
	const sites: Record<string, BrowserSiteLevel> = {
		...grant.sites,
		'*': 'deny',
	}
	for (const { site } of denies) sites[site] = 'deny'
	const compiled = compileBrowserSites(sites)
	return {
		rules: [
			...compiled.rules,
			{
				type: 'argument_pattern',
				toolNames: [BROWSER_TOOL_NAME],
				argument: 'action',
				pattern: '^(?:back|forward|reload)$',
				decision: 'allow',
			},
		],
		diagnostics: compiled.diagnostics,
	}
}

/** The grant in words, one line each, for a confirmation and `schedule show`. */
export function browserGrantLines(
	grant: ScheduleBrowserGrant,
	denies: readonly { readonly site: string; readonly path: string }[] = [],
): string[] {
	const denied = new Map(denies.map((d) => [d.site, d.path]))
	return [
		`browser: profile ${grant.profile}, ${grant.headed ? 'in a visible window' : 'no window'}`,
		...Object.entries(grant.sites).map(([site, level]) =>
			denied.has(site)
				? `browser ${site}: deny (from ${denied.get(site)})`
				: `browser ${site}: ${GRANT_WORDS[level]}`,
		),
		'browser any other site: deny',
		'browser sign-in, CAPTCHA or a code: the run stops and tells you',
	]
}

/**
 * Tools refused only by `unmatched: deny`: a write or a delegation that no
 * exemption lets through when nothing allows it. The agent tools go
 * together: without `Agent` the rest have nothing to act on.
 */
const STRICT_UNREACHABLE = [
	'Agent',
	'send_message',
	'cancel_agent',
	'wait_for_task',
	'agent_task_list',
	'agent_models',
	'save_memory',
	'update_memory',
	'delete_memory',
] as const
/** The background-job tools, which manage what `bash` started. */
const JOB_TOOLS = ['job', 'wait_for_job'] as const

/**
 * Whether `rule` could let `tool` through (allow it or send it to review).
 * Unknown shapes answer yes: withholding a tool the run could have used is the
 * mistake this must not make.
 */
function mayReach(rule: AuthorizationRule, tool: string): boolean {
	switch (rule.type) {
		case 'deny_by_name':
		case 'deny_dangerous_patterns':
			return false
		case 'allow_by_name':
			return rule.toolNames.includes(tool)
		case 'argument_pattern':
			return rule.decision !== 'deny' && rule.toolNames.includes(tool)
		case 'custom_pattern': {
			if (rule.decision === 'deny') return false
			const named = /^\^([A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/.exec(rule.pattern)
			return named ? named[1] === tool : true
		}
		case 'predicate':
			return !isFloorRule(rule)
		default:
			return true
	}
}

/**
 * Tools a scheduled run under this policy can never use, so their schemas
 * need not be sent with every model call. In a browser job's run, `bash`,
 * `edit`, `write`, the web tools and the agent and memory tools were about
 * half of each request, sent six times a run and refused every time they
 * could have been called.
 *
 * A tool is withheld when a `deny_by_name` names it and no rule before it
 * could let it through; under `unmatched: deny`, also the delegation and
 * memory-writing tools no rule names; and the background-job tools once
 * `bash` is withheld.
 */
export function withheldTools(
	set: SchedulePermissionSet,
	policy: Pick<CompiledJobPolicy, 'rules'>,
): string[] {
	const out = new Set<string>()
	policy.rules.forEach((rule, index) => {
		if (rule.type !== 'deny_by_name') return
		const earlier = policy.rules.slice(0, index)
		for (const tool of rule.toolNames) if (!earlier.some((r) => mayReach(r, tool))) out.add(tool)
	})
	if (set.unmatched === 'deny') {
		for (const tool of STRICT_UNREACHABLE)
			if (!policy.rules.some((r) => mayReach(r, tool))) out.add(tool)
	}
	if (out.has('bash')) for (const tool of JOB_TOOLS) out.add(tool)
	return [...out].sort()
}
