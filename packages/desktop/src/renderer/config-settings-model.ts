import type {
	ConfigSettingDefault,
	ConfigSettingDescriptor,
	ConfigSettingState,
	ConfigSettingsView,
} from '../shared/config-settings-protocol.js'
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
	if (control.kind === 'select')
		return control.options.find((o) => o.value === value)?.label ?? value
	return value
}

export function defaultNote(
	descriptor: ConfigSettingDescriptor,
	view?: ConfigSettingsView,
): string {
	const label = defaultLabel(descriptor, view)
	if (!label) return ''
	const note = descriptor.default !== undefined ? descriptor.defaultNote : undefined
	return `Default: ${label.replace(/\.$/, '')}.${note ? ` ${note}` : ''}`
}

const APPLIES_TEXT: Record<NonNullable<ConfigSettingDescriptor['appliesWhen']>, string> = {
	now: 'Applies at once.',
	'next-turn': 'Applies from your next message.',
	'next-conversation': 'Applies to new conversations. Open ones keep their current value.',
	'next-start': 'Applies the next time Namzu starts.',
	'next-launch': 'Applies the next time the app opens.',
}

/** The sentence about when a change reaches the work; empty from an engine that does not say. */
export function appliesLine(descriptor: ConfigSettingDescriptor): string {
	return descriptor.appliesWhen ? APPLIES_TEXT[descriptor.appliesWhen] : ''
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
