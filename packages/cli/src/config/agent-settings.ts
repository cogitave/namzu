/**
 * The settings the agent may read and, with the person's yes, change.
 *
 * Two tools stand on this file (`get_settings`, `set_setting`; see `agent-settings-tools.ts`). What
 * they may touch is an explicit allow-list in code, never "every setting the person can change":
 * a key joins {@link AGENT_SETTINGS} only after its descriptor (or the Desktop app's own catalogue
 * row) already validates the values it takes. Everything else, above all anything that decides what
 * Namzu may do (permissions, sandbox, browser, sites, tool servers, hooks, plugins, extensions,
 * computer use, trust, models and providers, keys, telemetry, updates), is refused with one plain
 * sentence ({@link NOT_FOR_THE_AGENT}).
 *
 * Two owners, one list. An `engine` row lives in the user config file and goes through the writer
 * Settings itself uses, so Settings shows the change at once. A `desktop` row belongs to the
 * Desktop app (notifications, keeping the computer awake): the engine reads the app's own file and
 * asks the app to apply the change, and only a host that has such a bridge offers those rows.
 */

import { type ReadSettingsOptions, checkSetting, writeSetting } from './desktop-settings.js'
import { type SettingRow, readSettingRow } from './setting-cli.js'
import { valueWords } from './setting-values.js'
import { SETTING_DESCRIPTORS, type SettingDescriptor } from './settings-descriptors.js'

/** The one sentence for every setting that is not on the list. */
export const NOT_FOR_THE_AGENT = 'That setting can only be changed by you in Settings.'

/** How an agent value is read: a switch, a choice from a list, or a line of text. */
type Shape = 'switch' | 'choice' | 'text'

interface EngineRow {
	readonly owner: 'engine'
	/** What the tool calls it. Stable. */
	readonly id: string
	/** The descriptor path the writer takes. */
	readonly path: string
}

interface DesktopRow {
	readonly owner: 'desktop'
	readonly id: string
	/** The key in the Desktop app's own preferences. */
	readonly key: string
	/** The name Settings shows for it. */
	readonly label: string
	readonly shape: 'switch' | 'choice'
	readonly choices?: readonly { readonly value: string; readonly label: string }[]
	readonly default: boolean | string
}

export type AgentSettingRow = EngineRow | DesktopRow

const NOTICE_LEVELS = [
	{ value: 'off', label: 'Off' },
	{ value: 'badge', label: 'Badge only' },
	{ value: 'banner', label: 'Banner' },
] as const
const BANNER_LEVELS = [
	{ value: 'off', label: 'Off' },
	{ value: 'banner', label: 'Banner' },
] as const

/**
 * Every setting the agent may change. The order is the order `get_settings` lists them in.
 *
 * Names follow Settings: an engine row takes its name, values and checks from its descriptor, a
 * Desktop row repeats the name its Settings row has (a test in the Desktop app compares the two).
 */
export const AGENT_SETTINGS: readonly AgentSettingRow[] = [
	{ owner: 'engine', id: 'archive_inactive_conversations', path: 'archiveInactive' },
	{ owner: 'engine', id: 'branch_prefix', path: 'worktrees.branchPrefix' },
	{ owner: 'engine', id: 'label_conversations_by_status', path: 'statusMarks' },
	{ owner: 'engine', id: 'closing_summary', path: 'closingSummary' },
	{ owner: 'engine', id: 'output_style', path: 'outputStyle' },
	{ owner: 'engine', id: 'prompt_suggestions', path: 'promptSuggestions' },
	{
		owner: 'desktop',
		id: 'permission_request_notifications',
		key: 'notifyPermission',
		label: 'Permission requests',
		shape: 'choice',
		choices: NOTICE_LEVELS,
		default: 'banner',
	},
	{
		owner: 'desktop',
		id: 'question_notifications',
		key: 'notifyQuestion',
		label: 'Questions',
		shape: 'choice',
		choices: NOTICE_LEVELS,
		default: 'banner',
	},
	{
		owner: 'desktop',
		id: 'finished_response_notifications',
		key: 'notifyTaskComplete',
		label: 'Task complete',
		shape: 'choice',
		choices: BANNER_LEVELS,
		default: 'banner',
	},
	{
		owner: 'desktop',
		id: 'response_error_notifications',
		key: 'notifyError',
		label: 'Response errors',
		shape: 'choice',
		choices: BANNER_LEVELS,
		default: 'banner',
	},
	{
		owner: 'desktop',
		id: 'draw_attention',
		key: 'attentionSignals',
		label: 'Draw attention when a conversation needs you',
		shape: 'switch',
		default: true,
	},
	{
		owner: 'desktop',
		id: 'notification_sound',
		key: 'notificationSound',
		label: 'Notification sound',
		shape: 'choice',
		choices: [
			{ value: 'system', label: 'System sound' },
			{ value: 'none', label: 'None' },
		],
		default: 'none',
	},
	{
		owner: 'desktop',
		id: 'keep_awake_while_working',
		key: 'keepAwakeWhileWorking',
		label: 'Keep computer awake while Namzu works',
		shape: 'switch',
		default: false,
	},
	{
		owner: 'desktop',
		id: 'keep_awake_on_battery',
		key: 'keepAwakeOnBattery',
		label: 'Keep awake on battery power',
		shape: 'switch',
		default: false,
	},
]

/** The longest line of text the agent may propose; the card shows all of it. */
export const AGENT_TEXT_MAX = 600

/** The Desktop app's own preferences, as the engine reaches them. Absent outside the Desktop app. */
export interface DesktopPreferences {
	/** The app's saved preferences by key; `undefined` when they cannot be read now. */
	read(): Record<string, unknown> | undefined
	/** Asks the app to save one preference. The app checks the value again. */
	write(key: string, value: string | boolean): void | Promise<void>
}

export interface AgentSettingsContext extends ReadSettingsOptions {
	readonly desktop?: DesktopPreferences
}

/** What one row looks like to the agent and to the person. */
interface ResolvedRow {
	readonly row: AgentSettingRow
	readonly name: string
	readonly description: string
	readonly shape: Shape
	/** The accepted values with the words Settings shows; absent for a switch and for text. */
	readonly choices?: readonly { readonly value: string; readonly label: string }[]
	readonly descriptor?: SettingDescriptor
}

function descriptorOf(path: string): SettingDescriptor {
	const found = SETTING_DESCRIPTORS.find((entry) => entry.path === path)
	if (!found) throw new Error(`The settings list names ${path}, which Settings does not have.`)
	return found
}

function resolveRow(row: AgentSettingRow): ResolvedRow {
	if (row.owner === 'desktop') {
		return {
			row,
			name: row.label,
			description: '',
			shape: row.shape,
			...(row.choices ? { choices: row.choices } : {}),
		}
	}
	const descriptor = descriptorOf(row.path)
	const control = descriptor.control
	if (control.kind === 'toggle')
		return {
			row,
			name: descriptor.label,
			description: descriptor.description,
			shape: 'switch',
			descriptor,
		}
	if (control.kind === 'select')
		return {
			row,
			name: descriptor.label,
			description: descriptor.description,
			shape: 'choice',
			choices: control.options.map((option) => ({ value: option.value, label: option.label })),
			descriptor,
		}
	if (control.kind === 'text')
		return {
			row,
			name: descriptor.label,
			description: descriptor.description,
			shape: 'text',
			descriptor,
		}
	throw new Error(`${row.path} has a control the agent settings do not read.`)
}

/** The rows this host offers: the Desktop rows only where the app can be reached. */
export function offeredRows(ctx: AgentSettingsContext): readonly ResolvedRow[] {
	return AGENT_SETTINGS.filter((row) => row.owner === 'engine' || ctx.desktop !== undefined).map(
		resolveRow,
	)
}

/** Who decides a value that is not the user's own file, in words. */
function deciderWords(row: SettingRow): string | undefined {
	switch (row.layer) {
		case 'managed':
			return 'your administrator'
		case 'env':
			return 'an environment variable'
		case 'project':
			return "this project's settings file"
		case 'local':
			return "this project's local settings file"
		case 'profile':
			return 'the profile in use'
		default:
			return undefined
	}
}

interface Held {
	/** The value in force. */
	readonly value: unknown
	/** The value in words, as Settings shows it. */
	readonly text: string
	/** Present when something other than the person's own file decides it: who, in words. */
	readonly lockedBy?: string
}

function engineHeld(resolved: ResolvedRow, ctx: AgentSettingsContext): Held {
	const row = readSettingRow((resolved.row as EngineRow).path, ctx)
	const descriptor = resolved.descriptor as SettingDescriptor
	const decider = deciderWords(row)
	const value =
		row.layer && row.layer !== 'user' && row.effective !== undefined
			? row.effective
			: row.set
				? row.value
				: row.default
	const text =
		value === undefined || value === ''
			? 'not set'
			: resolved.shape === 'text'
				? String(value)
				: valueWords(descriptor, value)
	return { value, text, ...(decider ? { lockedBy: decider } : {}) }
}

function desktopHeld(resolved: ResolvedRow, ctx: AgentSettingsContext): Held | undefined {
	const row = resolved.row as DesktopRow
	const saved = ctx.desktop?.read()
	if (saved === undefined) return undefined
	const raw = saved[row.key]
	const value =
		row.shape === 'switch'
			? typeof raw === 'boolean'
				? raw
				: row.default
			: typeof raw === 'string' && row.choices?.some((choice) => choice.value === raw)
				? raw
				: row.default
	return { value, text: wordsOf(resolved, value) }
}

function wordsOf(resolved: ResolvedRow, value: unknown): string {
	if (resolved.shape === 'switch') return value === true ? 'on' : 'off'
	if (resolved.shape === 'choice')
		return resolved.choices?.find((choice) => choice.value === value)?.label ?? String(value)
	return value === undefined || value === '' ? 'not set' : String(value)
}

function heldOf(resolved: ResolvedRow, ctx: AgentSettingsContext): Held | undefined {
	return resolved.row.owner === 'engine' ? engineHeld(resolved, ctx) : desktopHeld(resolved, ctx)
}

// ---------------------------------------------------------------------------
// get_settings
// ---------------------------------------------------------------------------

export interface AgentSettingView {
	readonly setting: string
	readonly name: string
	readonly description?: string
	/** The value in force, as data: a switch's true or false, a choice's value, a line of text. */
	readonly value: unknown
	/** The same, in the words Settings shows. */
	readonly valueText: string
	/** What `set_setting` accepts for a choice. */
	readonly accepts?: readonly string[]
	/** Present when the value cannot be changed from here, and why. */
	readonly locked?: string
}

export interface AgentSettingsReport {
	readonly settings: readonly AgentSettingView[]
	/** What the agent may read and never change. */
	readonly facts: readonly { readonly name: string; readonly value: string }[]
}

function fact(
	name: string,
	path: string,
	ctx: AgentSettingsContext,
): { name: string; value: string } {
	try {
		const row = readSettingRow(path, ctx)
		const fromLayer = Boolean(row.layer && row.layer !== 'user' && row.effective !== undefined)
		// Nothing saved: the default in the words Settings uses, its note included,
		// so a default that holds only in some places is not reported as holding
		// everywhere (the terminal starts in auto; a Desktop conversation does not).
		if (!fromLayer && !row.set) return { name, value: row.defaultText }
		const value = fromLayer ? row.effective : row.value
		return {
			name,
			value: value === undefined ? 'not set' : valueWords(descriptorOf(path), value),
		}
	} catch {
		return { name, value: 'unknown' }
	}
}

function defaultModelFact(ctx: AgentSettingsContext): { name: string; value: string } {
	try {
		const row = readSettingRow('routing', ctx)
		const target = (row.layer && row.layer !== 'user' ? row.effective : row.value) as
			| { default?: { provider?: unknown; model?: unknown } }
			| undefined
		const picked = target?.default
		if (picked && typeof picked.model === 'string')
			return {
				name: 'Default model',
				value:
					typeof picked.provider === 'string' && picked.provider
						? `${picked.provider}/${picked.model}`
						: picked.model,
			}
	} catch {
		return { name: 'Default model', value: 'unknown' }
	}
	return { name: 'Default model', value: 'not set' }
}

/** What `get_settings` returns: the settings the agent may change, and a few facts it may only read. */
export function readAgentSettings(ctx: AgentSettingsContext): AgentSettingsReport {
	const settings = offeredRows(ctx).map((resolved): AgentSettingView => {
		const held = heldOf(resolved, ctx)
		const accepts =
			resolved.shape === 'switch'
				? ['true', 'false']
				: resolved.shape === 'choice'
					? resolved.choices?.map((choice) => choice.value)
					: undefined
		return {
			setting: resolved.row.id,
			name: resolved.name,
			...(resolved.description ? { description: resolved.description } : {}),
			value: held?.value ?? null,
			valueText: held?.text ?? 'unknown',
			...(accepts ? { accepts } : {}),
			...(held?.lockedBy ? { locked: `Decided by ${held.lockedBy}.` } : {}),
			...(held === undefined ? { locked: 'The app cannot be reached just now.' } : {}),
		}
	})
	return {
		settings,
		facts: [
			fact('Default permission mode', 'permissions.defaultMode', ctx),
			fact('Bypass permissions mode allowed', 'permissions.allowBypassMode', ctx),
			{
				...fact('Auto mode removed', 'permissions.disableAutoMode', ctx),
			},
			fact('Computer use on', 'computerUse.enabled', ctx),
			defaultModelFact(ctx),
		],
	}
}

// ---------------------------------------------------------------------------
// set_setting
// ---------------------------------------------------------------------------

/** A change that was checked and may be put to the person. */
export interface PlannedChange {
	readonly setting: string
	readonly name: string
	/** What it is now, in words. */
	readonly from: string
	/** What it would become, in words. */
	readonly to: string
	/** True when the value already is the one asked for: nothing to ask or write. */
	readonly unchanged: boolean
	/** @internal The value to write. */
	readonly value: unknown
	/** @internal */
	readonly owner: 'engine' | 'desktop'
	/** @internal */
	readonly target: string
}

export type PlanResult =
	| { readonly ok: true; readonly change: PlannedChange }
	| { readonly ok: false; readonly reason: string }

const TRUE_WORDS = new Set(['true', 'on', 'yes'])
const FALSE_WORDS = new Set(['false', 'off', 'no'])

function readSwitch(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value
	if (typeof value !== 'string') return undefined
	const word = value.trim().toLowerCase()
	if (TRUE_WORDS.has(word)) return true
	if (FALSE_WORDS.has(word)) return false
	return undefined
}

function readChoice(resolved: ResolvedRow, value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	const word = value.trim().toLowerCase()
	return resolved.choices?.find(
		(choice) => choice.value.toLowerCase() === word || choice.label.toLowerCase() === word,
	)?.value
}

function acceptedWords(resolved: ResolvedRow): string {
	if (resolved.shape === 'switch') return 'on or off'
	if (resolved.shape === 'choice')
		return (resolved.choices ?? []).map((choice) => choice.value).join(', ')
	return `a line of text of at most ${AGENT_TEXT_MAX} characters`
}

/**
 * Checks one proposed change the way a write would, and touches nothing. Refuses, with a reason a
 * person can read, a setting that is not on the list, a value the setting does not take, and a
 * value some other layer decides. Never asks anyone.
 */
export function planAgentChange(
	ctx: AgentSettingsContext,
	input: { readonly setting: unknown; readonly value: unknown },
): PlanResult {
	const id = typeof input.setting === 'string' ? input.setting.trim() : ''
	const resolved = offeredRows(ctx).find((candidate) => candidate.row.id === id)
	if (!resolved) return { ok: false, reason: NOT_FOR_THE_AGENT }

	let value: unknown
	if (resolved.shape === 'switch') {
		value = readSwitch(input.value)
		if (value === undefined)
			return { ok: false, reason: `${resolved.name} takes ${acceptedWords(resolved)}.` }
	} else if (resolved.shape === 'choice') {
		value = readChoice(resolved, input.value)
		if (value === undefined)
			return { ok: false, reason: `${resolved.name} takes one of: ${acceptedWords(resolved)}.` }
	} else {
		if (typeof input.value !== 'string')
			return { ok: false, reason: `${resolved.name} takes ${acceptedWords(resolved)}.` }
		const text = input.value.trim()
		if (text.length > AGENT_TEXT_MAX)
			return { ok: false, reason: `${resolved.name} takes ${acceptedWords(resolved)}.` }
		// Empty means "no style": the key goes and the default applies again.
		value = text === '' ? undefined : text
	}

	const held = heldOf(resolved, ctx)
	if (held === undefined)
		return { ok: false, reason: `${resolved.name} cannot be read just now, so it is not changed.` }
	if (held.lockedBy)
		return {
			ok: false,
			reason: `${resolved.name} is decided by ${held.lockedBy}, so it cannot be changed here.`,
		}

	if (resolved.row.owner === 'engine') {
		// The writer's own checks, so a value it would refuse never costs the person a card.
		try {
			checkSetting({ path: resolved.row.path, value }, ctx)
		} catch (cause) {
			return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
		}
	}

	const to = wordsOf(resolved, value)
	return {
		ok: true,
		change: {
			setting: id,
			name: resolved.name,
			from: held.text,
			to,
			unchanged: held.value === value || (held.value === undefined && value === undefined),
			value,
			owner: resolved.row.owner,
			target: resolved.row.owner === 'engine' ? resolved.row.path : resolved.row.key,
		},
	}
}

/**
 * What the approval card says: the setting's name and the old and new value in the words Settings
 * uses. `undefined` for a call that will be refused anyway, so the card falls back to the plain one.
 */
export function describeAgentChange(
	ctx: AgentSettingsContext,
	input: unknown,
): { readonly setting: string; readonly from: string; readonly to: string } | undefined {
	if (typeof input !== 'object' || input === null) return undefined
	const planned = planAgentChange(ctx, input as { setting: unknown; value: unknown })
	if (!planned.ok || planned.change.unchanged) return undefined
	return { setting: planned.change.name, from: planned.change.from, to: planned.change.to }
}

/**
 * Makes a planned change after the person said yes. An engine row goes through the writer Settings
 * uses; a Desktop row is handed to the app. Returns the sentence the agent reads.
 */
export async function applyAgentChange(
	ctx: AgentSettingsContext,
	change: PlannedChange,
): Promise<string> {
	if (change.unchanged) return `${change.name} is already ${change.to}.`
	if (change.owner === 'engine') {
		writeSetting({ path: change.target, value: change.value }, ctx)
		return `${change.name} is now ${change.to}. Settings shows it.`
	}
	if (!ctx.desktop) throw new Error(`${change.name} cannot be changed from here.`)
	await ctx.desktop.write(change.target, change.value as string | boolean)
	return `${change.name} was sent to the app to change to ${change.to}; it applies at once.`
}
