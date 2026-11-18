import type {
	ConfigSettingDefault,
	ConfigSettingDescriptor,
	ConfigSettingState,
	ConfigSettingsView,
} from '../shared/config-settings-protocol.js'
import { listControlWords } from '../shared/config-settings-values.js'
import type { SettingsSection } from '../shared/settings-protocol.js'
import type { SettingsEntry } from './settings-model.js'

/** The element id suffix of a setting's row. Dots are not valid in a CSS-friendly id. */
export function configSettingId(path: string): string {
	return `cfg-${path.replace(/[^A-Za-z0-9]+/g, '-')}`
}

export function configSettingsFor(
	view: ConfigSettingsView | undefined,
	section: SettingsSection,
): ConfigSettingDescriptor[] {
	return view ? view.descriptors.filter((d) => d.section === section) : []
}

/**
 * The rows of a section in the order they are drawn, cut into runs that share a heading. The rows
 * with no group come first, then each group in the order the engine lists it (the engine lists a
 * section's rows with its groups already in order, so Desktop keeps no order of its own).
 */
export function configRowRuns(
	rows: readonly ConfigSettingDescriptor[],
): { heading?: string; rows: ConfigSettingDescriptor[] }[] {
	const runs: {
		group?: string
		heading?: string
		rows: ConfigSettingDescriptor[]
	}[] = []
	const open = (group: string | undefined, heading: string | undefined) => {
		const run = runs.find((item) => item.group === group)
		if (run) return run
		const created: {
			group?: string
			heading?: string
			rows: ConfigSettingDescriptor[]
		} = {
			...(group !== undefined ? { group } : {}),
			...(heading !== undefined ? { heading } : {}),
			rows: [],
		}
		runs.push(created)
		return created
	}
	for (const row of rows) open(row.group, row.groupLabel).rows.push(row)
	// A row with no group is drawn above the groups even when a group was listed first.
	runs.sort((a, b) => Number(a.group !== undefined) - Number(b.group !== undefined))
	return runs.map(({ heading, rows: list }) => ({
		...(heading ? { heading } : {}),
		rows: list,
	}))
}

export function stateFor(view: ConfigSettingsView, path: string): ConfigSettingState | undefined {
	return view.settings.find((s) => s.path === path)
}

/**
 * What the setting holds with nothing saved: the typed default, or the rule that applies when one
 * of the other settings it depends on is set. An engine older than the typed default sends only
 * words, and then there is no value to give.
 */
export function effectiveDefault(
	descriptor: ConfigSettingDescriptor,
	view?: ConfigSettingsView,
): ConfigSettingDefault | undefined {
	for (const rule of descriptor.defaultWhen ?? []) {
		const state = view ? stateFor(view, rule.path) : undefined
		if (!state?.set) continue
		const value = state.value
		const hit =
			rule.is === 'non-empty'
				? Array.isArray(value)
					? value.length > 0
					: value !== undefined && value !== null && value !== '' && value !== false
				: value === rule.is
		if (hit) return rule.value
	}
	return descriptor.default
}

/** What a switch shows while nothing is saved. */
export function defaultToggle(
	descriptor: ConfigSettingDescriptor,
	view?: ConfigSettingsView,
): boolean {
	const value = effectiveDefault(descriptor, view)
	if (typeof value === 'boolean') return value
	// An engine older than the typed default: the words are all there is.
	return descriptor.defaultText?.trim().toLowerCase().startsWith('on') ?? false
}

/** The default as a person reads it: On, Off, a number with its unit, an option's label. */
export function defaultLabel(
	descriptor: ConfigSettingDescriptor,
	view?: ConfigSettingsView,
): string | undefined {
	const value = effectiveDefault(descriptor, view)
	const control = descriptor.control
	if (value === undefined) return descriptor.defaultText
	const listed = typeof value === 'boolean' ? undefined : listControlWords(control, value)
	if (listed !== undefined) return listed.charAt(0).toUpperCase() + listed.slice(1)
	if (typeof value === 'boolean') return value ? 'On' : 'Off'
	if (Array.isArray(value)) {
		if (value.length === 0) return 'none'
		const options = control.kind === 'checks' ? control.options : []
		return value.map((item) => options.find((o) => o.value === item)?.label ?? item).join(', ')
	}
	if (typeof value === 'number') {
		if (control.kind === 'number' && control.unit === 'ms') return formatDuration(value)
		return control.kind === 'number' && control.unit ? `${value} ${control.unit}` : String(value)
	}
	if (typeof value === 'object') return descriptor.defaultText
	if (control.kind === 'select')
		return control.options.find((o) => o.value === value)?.label ?? value
	return value
}

/**
 * The default a row says in words under it, for the controls that cannot show it themselves. A
 * switch shows none, a choice marks its default inside the list, and a number or a text box shows
 * it as the placeholder. Empty for those, and for a row with nothing to say.
 */
export function defaultHelper(
	descriptor: ConfigSettingDescriptor,
	view?: ConfigSettingsView,
): string {
	const own: readonly string[] = ['toggle', 'toggle-list', 'toggle-checks', 'select', 'key']
	if (own.includes(descriptor.control.kind)) return ''
	// A text box with its own placeholder already says what an empty box means.
	if (descriptor.control.kind === 'text' && descriptor.control.placeholder) return ''
	// An empty list by default says so itself ("No extra folders."), so a line under it repeats it.
	if (Array.isArray(descriptor.default) && descriptor.default.length === 0) return ''
	// A number or text box shows a short default as its placeholder. A default that is a sentence
	// does not fit there (the placeholder falls back to the word 'default'), so say it under the row.
	if (descriptor.control.kind === 'number' || descriptor.control.kind === 'text') {
		const fits =
			typeof descriptor.default === 'number' ||
			typeof descriptor.default === 'string' ||
			(descriptor.defaultText ?? '').length <= 12
		if (fits) return ''
	}
	const label = defaultLabel(descriptor, view)
	return label ? `Default · ${label.replace(/\.$/, '')}` : ''
}

/** What a row that waits for a restart shows beside its name, or nothing for one that does not. */
export function restartBadge(
	descriptor: ConfigSettingDescriptor,
): { text: string; sentence: string } | undefined {
	if (descriptor.appliesWhen !== 'next-start' && descriptor.appliesWhen !== 'next-launch')
		return undefined
	return { text: 'After restart', sentence: appliesLine(descriptor) }
}

const APPLIES_TEXT: Record<NonNullable<ConfigSettingDescriptor['appliesWhen']>, string> = {
	now: 'Applies at once.',
	'next-turn': 'Applies from your next message.',
	'next-conversation': 'Applies to new conversations. Open ones keep what they have.',
	'next-start': 'Applies the next time Namzu starts.',
	'next-launch': 'Applies the next time the app opens.',
}

/** The sentence about when a change reaches the work; empty from an engine that does not say. */
export function appliesLine(descriptor: ConfigSettingDescriptor): string {
	if (!descriptor.appliesWhen) return ''
	// The terminal app's own rows say which program restarts, as the engine does in its list.
	if (
		descriptor.appliesWhen === 'next-start' &&
		(descriptor.path.startsWith('tui.') ||
			descriptor.path.startsWith('composerTriggers.') ||
			descriptor.path === 'statusLine')
	)
		return 'Applies the next time the terminal app starts.'
	return APPLIES_TEXT[descriptor.appliesWhen]
}

/** A list or table, as the text the editor starts from. */
export function jsonText(value: unknown): string {
	return value === undefined ? '' : JSON.stringify(value, null, 2)
}

const MS_UNITS = { h: 3_600_000, m: 60_000, s: 1_000 } as const

/** A time as a person writes it: `5m`, `90s`, `1h 30m`, `250ms`. A bare number is minutes. */
export function parseDuration(text: string): number | undefined {
	const t = text.trim().toLowerCase()
	if (t === '') return undefined
	if (/^\d+(?:\.\d+)?$/.test(t)) return Math.round(Number(t) * MS_UNITS.m)
	const match =
		/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?!s))?\s*(?:(\d+(?:\.\d+)?)\s*s)?\s*(?:(\d+)\s*ms)?$/.exec(
			t,
		)
	if (!match) return undefined
	const [, h, m, s, ms] = match
	return Math.round(
		Number(h ?? 0) * MS_UNITS.h +
			Number(m ?? 0) * MS_UNITS.m +
			Number(s ?? 0) * MS_UNITS.s +
			Number(ms ?? 0),
	)
}

/** Milliseconds as minutes and seconds: `5m`, `1m 30s`, `250ms`; 0 stays `0`. */
export function formatDuration(ms: number): string {
	if (ms === 0) return '0'
	const parts: string[] = []
	let rest = ms
	for (const [unit, size] of [
		['h', MS_UNITS.h],
		['m', MS_UNITS.m],
		['s', MS_UNITS.s],
	] as const) {
		const n = Math.floor(rest / size)
		if (n > 0) parts.push(`${n}${unit}`)
		rest -= n * size
	}
	if (rest > 0) parts.push(`${rest}ms`)
	return parts.join(' ')
}

/** A token count as written: `786k`, `1m`, `200000`. */
export function parseTokens(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(text.trim().toLowerCase().replace(/,/g, ''))
	if (!match) return undefined
	const [, n, suffix] = match
	return Math.round(Number(n) * (suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1))
}

function formatTokens(value: number): string {
	if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}m`
	if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}k`
	return String(value)
}

/** A number as its box shows it: a time in minutes and seconds, anything else as it is. */
export function displayNumber(value: number, unit?: string): string {
	return unit === 'ms' ? formatDuration(value) : String(value)
}

function bound(value: number, unit?: string): string {
	return unit === 'ms'
		? formatDuration(value)
		: unit === 'tokens'
			? formatTokens(value)
			: String(value)
}

/** The range a number box takes, as a short sentence; empty when it is any whole number from 0. */
export function rangeText(control: { min?: number; max?: number; unit?: string }): string {
	const { min, max, unit } = control
	// A time limit of weeks is no range worth reading; only a short span is named.
	if (unit === 'ms' && (max === undefined || max > 86_400_000)) return ''
	if (min !== undefined && max !== undefined)
		return `From ${bound(min, unit)} to ${bound(max, unit)}.`
	if (max !== undefined) return `Up to ${bound(max, unit)}.`
	// A time that must be at least a millisecond is no limit worth naming.
	if (min !== undefined && min > 0 && !(unit === 'ms' && min < 1000))
		return `At least ${bound(min, unit)}.`
	return ''
}

/**
 * A number field's text to the number sent, or the sentence to show. A time box takes minutes and
 * seconds and a token box takes 200k or 1m. The engine checks the same bounds again; this only
 * stops a request that cannot be right.
 */
export function numberFromText(
	text: string,
	control: { min?: number; max?: number; unit?: string },
): { value: number } | { error: string } {
	const trimmed = text.trim()
	let value: number | undefined
	let wrong = 'Enter a number.'
	if (control.unit === 'ms') {
		value = parseDuration(trimmed)
		wrong = 'Enter minutes and seconds, such as 5m or 90s.'
	} else if (control.unit === 'tokens') {
		value = parseTokens(trimmed)
		wrong = 'Enter a number, such as 200000, 200k or 1m.'
	} else if (trimmed !== '' && Number.isFinite(Number(trimmed))) value = Number(trimmed)
	if (value === undefined || !Number.isFinite(value)) return { error: wrong }
	if (control.min !== undefined && value < control.min)
		return { error: `Enter ${bound(control.min, control.unit)} or more.` }
	if (control.max !== undefined && value > control.max)
		return { error: `Enter ${bound(control.max, control.unit)} or less.` }
	return { value }
}

/** The warning a setting shows while the setting it needs is not in the state it needs. */
export function requirementNote(
	descriptor: ConfigSettingDescriptor,
	view: ConfigSettingsView,
): string {
	const need = descriptor.requires
	if (!need) return ''
	const state = stateFor(view, need.path)
	const other = view.descriptors.find((d) => d.path === need.path)
	const current = state?.set ? state.value : other ? effectiveDefault(other, view) : undefined
	return current === need.is ? '' : need.note
}

/** A short placeholder for a number box: the typed default, or the words when they fit the box. */
export function numberPlaceholder(descriptor: ConfigSettingDescriptor): string {
	const unit = descriptor.control.kind === 'number' ? descriptor.control.unit : undefined
	if (typeof descriptor.default === 'number') return displayNumber(descriptor.default, unit)
	const words = descriptor.defaultText ?? ''
	return words.length <= 12 ? words : 'default'
}

/** Search entries for every engine setting, so the page's search finds them with the rest. */
/** The sections whose page draws a group of the engine's rows (`ConfigSettingsGroup`). */
export const CONFIG_GROUP_SECTIONS: readonly SettingsSection[] = [
	'general',
	'models',
	'agent',
	'tools',
	'projects',
	'terminal',
	'telemetry',
	'updates',
]

/**
 * Engine settings the page draws as a row of its own (tool servers, Run hooks, Hooks), so the
 * plain row is neither drawn in the group nor offered by search. Search finds those rows by their
 * own entries in the settings catalogue.
 */
export const OWN_ROW_CONFIG_PATHS: readonly string[] = ['mcpServers', 'disableHooks', 'hooks']

/** Search offers a row only where the page draws it. */
export function configSearchEntries(view: ConfigSettingsView | undefined): SettingsEntry[] {
	if (!view) return []
	return view.descriptors
		.filter(
			(d) => CONFIG_GROUP_SECTIONS.includes(d.section) && !OWN_ROW_CONFIG_PATHS.includes(d.path),
		)
		.map((d) => ({
			id: configSettingId(d.path),
			section: d.section,
			label: d.label,
			description: d.description,
			keywords: [...(d.keywords ?? []), ...d.path.split('.')],
		}))
}

/** The words of the dialog that asks before a risky setting changes. */
export function confirmationCopy(message: string) {
	return {
		title: 'Change this setting?',
		description: message,
		confirm: 'Change it',
		cancel: 'Cancel',
	}
}

/**
 * What leaving a text box does. A box with no typing changes nothing; one typed back to the saved
 * value is a discard (so a refusal shown for the earlier text goes), anything else is a save.
 */
export function textCommitAction(
	draft: string | undefined,
	saved: string,
): 'nothing' | 'discard' | 'save' {
	if (draft === undefined) return 'nothing'
	return draft === saved ? 'discard' : 'save'
}

const squash = (text: string): string =>
	text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()

/**
 * `line` for the second line under a row, or nothing when it only says again what the row's
 * description already says (a choice whose help is the description's first sentence).
 */
export function unlessRepeated(line: string | undefined, description: string | undefined): string {
	if (!line) return ''
	const flat = squash(line)
	if (flat && description && squash(description).includes(flat)) return ''
	return line
}
