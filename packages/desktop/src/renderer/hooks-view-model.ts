import type {
	HookModuleRow,
	HookProblem,
	HookRow,
	HookState,
	HooksReport,
	SwitchReport,
} from '../shared/hooks-report.js'

/**
 * What the hooks view says, as data. The engine supplies the facts (what starts, where it comes
 * from, its state and why); this file only puts them in plain words and in an order. Nothing here
 * runs a hook or reads a file, and nothing invents a hook the engine did not list.
 */

/** When each event fires, in the order a conversation goes through them. */
const WHEN: readonly [event: string, when: string][] = [
	['session_start', 'When a conversation starts'],
	['user_prompt_submit', 'When you send a message'],
	['turn_start', 'When a reply starts'],
	['pre_tool_use', 'Before a tool runs'],
	['permission_request', 'When a tool asks your permission'],
	['permission_denied', 'When a tool call is refused'],
	['post_tool_use', 'After a tool runs'],
	['post_tool_use_failure', 'After a tool fails'],
	['post_tool_batch', 'After a group of tool calls'],
	['pre_compact', 'Before a conversation is shortened'],
	['post_compact', 'After a conversation is shortened'],
	['subagent_start', 'When a sub-agent starts'],
	['subagent_stop', 'When a sub-agent finishes'],
	['turn_end', 'When a reply is about to finish'],
	['turn_failure', 'When a reply fails'],
	['notification', 'When Namzu wants your attention'],
	['file_changed', 'When a watched file changes'],
	['cwd_changed', 'When the working folder changes'],
	['worktree_create', 'When a worktree is made'],
	['worktree_remove', 'When a worktree is removed'],
	['session_end', 'When a conversation ends'],
]

/** The other spelling of an event, so a problem that names one finds the group of the other. */
const WRITTEN: Record<string, string> = {
	UserPromptSubmit: 'user_prompt_submit',
	SessionStart: 'session_start',
	SessionEnd: 'session_end',
	PreToolUse: 'pre_tool_use',
	PostToolUse: 'post_tool_use',
	PostToolUseFailure: 'post_tool_use_failure',
	PermissionRequest: 'permission_request',
	Notification: 'notification',
	PreCompact: 'pre_compact',
	PostCompact: 'post_compact',
	SubagentStart: 'subagent_start',
	SubagentStop: 'subagent_stop',
	PostToolBatch: 'post_tool_batch',
	PermissionDenied: 'permission_denied',
	StopFailure: 'turn_failure',
	Stop: 'turn_end',
	FileChanged: 'file_changed',
}

/** The kernel's name for an event written either way. */
export function kernelEvent(event: string): string {
	return WRITTEN[event] ?? event
}

export function whenLabel(event: string): string {
	return WHEN.find(([name]) => name === event)?.[1] ?? `On ${event}`
}

const SCOPE_WORDS: Record<string, string> = {
	user: 'Your own settings',
	project: 'This folder’s settings',
	local: 'This folder’s local settings',
	profile: 'A profile',
	managed: 'Your administrator’s settings',
	system: 'Built in',
}

const STATE_WORDS: Record<HookState, string> = {
	runs: 'Runs',
	off: 'Off',
	'attaches-when-used': 'When used',
	'not-loaded': 'Not loaded',
}

export interface HookRowView {
	id: string
	/** What it starts, as the engine wrote it. */
	runs: string
	/** `Asks the model:` and the like, before `runs`, for the kinds that are not a command. */
	kind?: string
	state: HookState
	stateLabel: string
	/** The engine's own reason, for a hook that is off or not loaded. */
	why?: string
	/** Matcher, condition and options, one short phrase each. */
	facts: string[]
	notes: string[]
	/** Where it comes from, in words. */
	source: string
	/** Where to change it. */
	change: string
}

export interface ProblemView {
	severity: 'problem' | 'note'
	source: string
	text: string
	inactive: boolean
}

export interface HooksGroupView {
	/** The kernel's event name, or a group's key when it is not an event. */
	key: string
	when: string
	event?: string
	hooks: HookRowView[]
	problems: ProblemView[]
}

function sourceWords(row: { origin: HookRow['origin'] }): string {
	const { origin } = row
	switch (origin.kind) {
		case 'plugin':
			return `Plugin ${origin.name ?? origin.label.replace(/^plugin /, '')}`
		case 'skill':
			return `Skill ${origin.name ?? origin.label.replace(/^skill /, '')}`
		case 'agent':
			return `Agent file ${origin.name ?? origin.label.replace(/^agent /, '')}`
		default: {
			const scope = origin.scope ? (SCOPE_WORDS[origin.scope] ?? origin.scope) : 'Settings'
			return origin.scope === 'profile' && origin.name ? `Profile ${origin.name}` : scope
		}
	}
}

function changeWords(row: { origin: HookRow['origin'] }): string {
	const { origin } = row
	const where = origin.path ?? origin.label
	switch (origin.kind) {
		case 'plugin':
			return `Change it in the plugin’s own files (${where}).`
		case 'skill':
			return `Change it in the skill’s file (${where}).`
		case 'agent':
			return `Change it in the agent file (${where}).`
		default:
			return origin.scope === 'managed'
				? `Set by your administrator (${where}); it cannot be changed here.`
				: `Change it in ${where}.`
	}
}

function seconds(ms: number): string {
	const value = ms / 1000
	return Number.isInteger(value) ? `${value}` : value.toFixed(1)
}

/** The two switches hold back every hook alike, so that reason is said once for the list, not on each row. */
const SWITCH_CODES = ['disableHooks', 'hooksManagedOnly']

function showsOwnWhy(row: HookRow): boolean {
	return (
		(row.state === 'off' || row.state === 'not-loaded') &&
		!(row.why && SWITCH_CODES.includes(row.why.code))
	)
}

export function hookRowView(row: HookRow): HookRowView {
	const facts: string[] = []
	if (row.matcher) facts.push(`Matches ${row.matcher}`)
	if (row.condition) facts.push(`Only if ${row.condition}`)
	if (row.once) facts.push('Once per conversation')
	if (row.async) facts.push('Runs in the background')
	if (row.timeoutMs !== undefined) facts.push(`Stops after ${seconds(row.timeoutMs)} s`)
	if (row.onFailure === 'block') facts.push('Refuses the action if it fails')
	return {
		id: row.id,
		runs: row.runs,
		...(row.type === 'prompt' ? { kind: 'Asks the model:' } : {}),
		state: row.state,
		stateLabel: STATE_WORDS[row.state],
		...(showsOwnWhy(row) ? { why: row.why?.text } : {}),
		facts,
		notes: row.notes ?? [],
		source: sourceWords(row),
		change: changeWords(row),
	}
}

function problemView(problem: HookProblem): ProblemView {
	const where = [sourceWords(problem), problem.file].filter(Boolean).join(', ')
	return {
		severity: problem.severity,
		source: where,
		text: problem.message,
		inactive: problem.inactive === 'folder-not-trusted',
	}
}

/** The plugin programs a plugin lists as hooks: named by the engine, never loaded by it. */
export interface ModuleView {
	id: string
	plugin: string
	module: string
	state: HookState
	stateLabel: string
	why?: string
	change: string
}

export function moduleView(module: HookModuleRow, index: number): ModuleView {
	return {
		id: `${module.plugin}:${module.module}:${index}`,
		plugin: module.plugin,
		module: module.module,
		state: module.state,
		stateLabel: STATE_WORDS[module.state],
		...(module.state === 'off' || module.state === 'not-loaded' ? { why: module.why?.text } : {}),
		change: `Change it in the plugin’s own files (${module.origin.path ?? module.origin.label}).`,
	}
}

export interface HooksListView {
	groups: HooksGroupView[]
	/** Problems that name no event, kept with the source they are about. */
	unplaced: ProblemView[]
	modules: ModuleView[]
	/** How many hooks there are, of any state. */
	total: number
	/** The engine's answer had entries this app could not read. */
	unreadable: number
	summary: string
	/** What a switch is holding back, in the engine's words, when one is. */
	heldBack?: string
	empty: boolean
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`
}

function summaryOf(report: HooksReport): string {
	const { counts } = report
	const parts: string[] = []
	if (counts.runs > 0) parts.push(`${counts.runs} running`)
	if (counts.attachesWhenUsed > 0) parts.push(`${counts.attachesWhenUsed} when used`)
	if (counts.off > 0) parts.push(`${counts.off} off`)
	if (counts.notLoaded > 0) parts.push(`${counts.notLoaded} not loaded`)
	return parts.join(' · ')
}

/** The hooks grouped by when they run; each problem sits with the event it names, else with its source. */
export function hooksListView(report: HooksReport): HooksListView {
	const groups = new Map<string, HooksGroupView>()
	const group = (event: string): HooksGroupView => {
		const key = kernelEvent(event)
		let found = groups.get(key)
		if (!found) {
			found = { key, when: whenLabel(key), event: key, hooks: [], problems: [] }
			groups.set(key, found)
		}
		return found
	}
	for (const row of report.hooks) group(row.event).hooks.push(hookRowView(row))
	const unplaced: ProblemView[] = []
	for (const problem of report.problems) {
		if (problem.event) group(problem.event).problems.push(problemView(problem))
		else unplaced.push(problemView(problem))
	}
	const known = WHEN.map(([name]) => name)
	const ordered = [
		...known.flatMap((name) => groups.get(name) ?? []),
		...[...groups.values()].filter((item) => !known.includes(item.key)),
	]
	const modules = report.modules.map(moduleView)
	const held = report.hooks.find(
		(row) => row.state === 'off' && row.why && SWITCH_CODES.includes(row.why.code),
	)
	return {
		groups: ordered,
		unplaced,
		modules,
		total: report.hooks.length,
		unreadable: report.unreadable ?? 0,
		summary: summaryOf(report),
		...(held?.why ? { heldBack: held.why.text } : {}),
		empty:
			report.hooks.length === 0 &&
			modules.length === 0 &&
			report.problems.length === 0 &&
			(report.unreadable ?? 0) === 0 &&
			report.error === undefined,
	}
}

export const EMPTY_HOOKS =
	'No hooks are set up here: they are written under “hooks” in a config file (your own, or a project’s namzu.config.json), in a plugin, or in the front matter of a skill or an agent file.'

export const OLD_ENGINE_HOOKS =
	'This version of Namzu cannot list hooks. Update Namzu to see what runs by itself here.'

/** What the group says under its title: whose hooks these are and that the list does not edit. */
export function hooksNote(own: boolean, projectName: string | undefined): string {
	const whose = own
		? 'The hooks of your own settings, which apply in every folder. Open a project to see what it adds.'
		: projectName
			? `What runs by itself in “${projectName}”.`
			: 'What runs by itself in the open project.'
	return `${whose} This list is read-only: each entry says where to change it.`
}

export function untrustedLine(report: HooksReport): string | undefined {
	if (report.folder.trusted) return undefined
	const waiting = report.counts.waitingForTrust
	return waiting > 0
		? `This folder is not trusted yet, so ${plural(waiting, 'hook', 'hooks')} in it ${waiting === 1 ? 'has' : 'have'} not started. They start once you trust it.`
		: 'This folder is not trusted yet. Nothing in it has started.'
}

/** Where a setting was made, for the line under a locked switch. */
function placeOf(report: SwitchReport): string {
	const by = report.setBy
	if (!by) return 'another setting'
	switch (by.kind) {
		case 'env':
			return `the environment variable ${by.variable ?? 'NAMZU_DISABLE_HOOKS'}`
		case 'managed':
			return `your administrator’s settings${by.path ? ` (${by.path})` : ''}`
		case 'profile':
			return `the profile ${by.profile ?? ''}${by.path ? ` (${by.path})` : ''}`.replace('  ', ' ')
		case 'project-file':
		case 'local-file':
			return `a project file${by.path ? ` (${by.path})` : ''}`
		default:
			return by.path ?? by.kind
	}
}

export interface RunHooksState {
	/** The switch is on: hooks run. */
	on: boolean
	/** Why it cannot be changed here, in one line; absent when it can. */
	locked?: string
	/** The engine's answer is not in yet, so the switch is left alone. */
	waiting?: boolean
}

/**
 * The state of "Run hooks". It is bound to the user-level `disableHooks` setting, so it can only be
 * changed while that setting is what decides. When the managed file or the environment decides (or
 * hooks are limited to managed ones) it says so and is left alone.
 */
export function runHooksState(
	report: HooksReport | undefined,
	setting: { value?: unknown; set: boolean } | undefined,
): RunHooksState {
	if (report) {
		const { disableHooks, hooksManagedOnly } = report.switches
		if (hooksManagedOnly.on)
			return {
				on: false,
				locked: `Only the hooks in the managed file run: ${placeOf(hooksManagedOnly)} requires it, so this switch cannot change it.`,
			}
		const by = disableHooks.setBy?.kind
		if (by !== undefined && by !== 'default' && by !== 'user-file')
			return {
				on: !disableHooks.on,
				locked: `${disableHooks.on ? 'Hooks are switched off' : 'Hooks are kept on'} by ${placeOf(disableHooks)}, so this switch cannot change it.`,
			}
		return { on: !disableHooks.on }
	}
	return { on: !(setting?.set && setting.value === true) }
}

/** The value `disableHooks` takes when the person picks a state: the default again when hooks run. */
export function disableHooksValue(runHooks: boolean): true | undefined {
	return runHooks ? undefined : true
}

/**
 * What to say right after the switch was saved. A connected project keeps the settings it started
 * with, so the list below reads "Off" while that project's hooks still fire; a person who switched
 * hooks off must not be left to think they stopped.
 */
export function savedHooksNote(runHooks: boolean): string {
	return runHooks
		? 'Saved. A project that is already open keeps running without hooks until Namzu connects to it again.'
		: 'Saved, but a project that is already open keeps running its hooks until Namzu connects to it again. Close and reopen the project to stop them now.'
}
