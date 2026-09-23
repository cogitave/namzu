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
import { READ_ONLY_VERBS, scheduledRunFloorRule } from './floor.js'
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
	// Web tools are denied by name unless the job itself lets them run: the
	// gate's read-only default would otherwise approve a fetch.
	const networkDenied = NETWORK_TOOLS.filter((t) => set.rules[t] === undefined)
	const rules: AuthorizationRule[] = [
		...scheduledRunFloor(
			options.namzuHome,
			homedir(),
			options.folder ? [options.folder.path, options.folder.canonical] : [],
		),
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
