/**
 * The settings the engine owns. Desktop does not know their names: the engine describes each
 * one (label, control, whether a change is confirmed first) and Desktop draws what it is told.
 * A key added to the engine's list appears in Settings with no change here.
 */

export type ConfigSettingSection =
	| 'general'
	| 'models'
	| 'projects'
	| 'appearance'
	| 'updates'
	| 'agent'
	| 'tools'
	| 'telemetry'
	| 'terminal'

const SECTIONS: readonly string[] = [
	'general',
	'models',
	'projects',
	'appearance',
	'updates',
	'agent',
	'tools',
	'telemetry',
	'terminal',
]

export type ConfigSettingAppliesWhen =
	| 'now'
	| 'next-turn'
	| 'next-conversation'
	| 'next-start'
	| 'next-launch'

const APPLIES_WHEN: readonly string[] = [
	'now',
	'next-turn',
	'next-conversation',
	'next-start',
	'next-launch',
]

/** A value a setting holds when nothing is saved. A list is the list of ticked option values. */
export type ConfigSettingDefault = boolean | number | string | string[]

export interface ConfigSettingOption {
	value: string
	label: string
	/** One line saying what choosing it does. */
	help?: string
}

/** Which file a saved value came from. The engine fills it; absent means it was not said. */
export type ConfigSettingLayer = 'user' | 'project' | 'local' | 'profile' | 'managed'

const LAYERS: readonly string[] = ['user', 'project', 'local', 'profile', 'managed']

export type ConfigSettingControl =
	| { kind: 'toggle' }
	| { kind: 'select'; options: ConfigSettingOption[] }
	| { kind: 'checks'; options: ConfigSettingOption[] }
	| { kind: 'number'; min?: number; max?: number; unit?: string }
	| { kind: 'text'; placeholder?: string }
	| { kind: 'json'; example: string }
	| { kind: 'file-only' }

export interface ConfigSettingDescriptor {
	path: string
	label: string
	description: string
	section: ConfigSettingSection
	control: ConfigSettingControl
	/** What the setting holds with nothing saved. Draw the default from this, never from prose. */
	default?: ConfigSettingDefault
	/** A caveat said beside the default, for example that CI differs. */
	defaultNote?: string
	/** Cases where the default is not `default`: the first rule whose key matches decides. */
	defaultWhen?: { path: string; is: 'non-empty' | string; value: ConfigSettingDefault }[]
	/** The default in words. Used only when there is no typed `default`. */
	defaultText?: string
	/** When a saved change reaches the work. Absent from an engine older than the field. */
	appliesWhen?: ConfigSettingAppliesWhen
	confirm?: string
	/** Which new value asks: `on`/`off` for a toggle, `zero` for a cap. Absent: every change asks. */
	confirmWhen?: 'on' | 'off' | 'zero'
	/** For a select, the one new value that asks. Absent: every change asks. */
	confirmValue?: string
	keywords?: string[]
}

export interface ConfigSettingState {
	path: string
	set: boolean
	/** Never present for a `file-only` setting. */
	value?: unknown
	/** The file the value came from, when the engine says. */
	layer?: ConfigSettingLayer
}

export interface ConfigSettingsView {
	file: string
	descriptors: ConfigSettingDescriptor[]
	settings: ConfigSettingState[]
}

/** A change with no `value` puts the default back. A list or table is sent as JSON text. */
export interface ConfigSettingChange {
	path: string
	value?: unknown
}

export type ConfigSettingResult =
	| { status: 'saved'; view: ConfigSettingsView }
	| { status: 'confirm'; view: ConfigSettingsView; token: string; message: string }

function defaultValue(value: unknown): ConfigSettingDefault | undefined {
	if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
		return value
	if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
		return value as string[]
	return undefined
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

function options(value: unknown): ConfigSettingOption[] | undefined {
	if (!Array.isArray(value)) return undefined
	const out: ConfigSettingOption[] = []
	for (const item of value) {
		const entry = record(item)
		if (!entry || typeof entry.value !== 'string' || typeof entry.label !== 'string')
			return undefined
		out.push({
			value: entry.value,
			label: entry.label,
			...(typeof entry.help === 'string' ? { help: entry.help } : {}),
		})
	}
	return out
}

function control(value: unknown): ConfigSettingControl | undefined {
	const c = record(value)
	if (!c) return undefined
	switch (c.kind) {
		case 'toggle':
		case 'file-only':
			return { kind: c.kind }
		case 'select':
		case 'checks': {
			const list = options(c.options)
			return list ? { kind: c.kind, options: list } : undefined
		}
		case 'number':
			return {
				kind: 'number',
				...(typeof c.min === 'number' ? { min: c.min } : {}),
				...(typeof c.max === 'number' ? { max: c.max } : {}),
				...(typeof c.unit === 'string' ? { unit: c.unit } : {}),
			}
		case 'text':
			return {
				kind: 'text',
				...(typeof c.placeholder === 'string' ? { placeholder: c.placeholder } : {}),
			}
		case 'json':
			return typeof c.example === 'string' ? { kind: 'json', example: c.example } : undefined
		default:
			return undefined
	}
}

function readDefaultWhen(value: unknown[]): NonNullable<ConfigSettingDescriptor['defaultWhen']> {
	const out: NonNullable<ConfigSettingDescriptor['defaultWhen']> = []
	for (const item of value) {
		const rule = record(item)
		const outcome = rule ? defaultValue(rule.value) : undefined
		if (
			!rule ||
			typeof rule.path !== 'string' ||
			typeof rule.is !== 'string' ||
			outcome === undefined
		)
			continue
		out.push({ path: rule.path, is: rule.is, value: outcome })
	}
	return out
}

/**
 * Reads the engine's answer. An entry Desktop cannot draw is dropped rather than failing the page,
 * so an engine newer than the app still shows everything the app understands.
 */
export function readConfigSettingsView(value: unknown): ConfigSettingsView {
	const root = record(value)
	if (!root || !Array.isArray(root.descriptors) || !Array.isArray(root.settings))
		throw new Error('The settings could not be read.')
	const descriptors: ConfigSettingDescriptor[] = []
	for (const item of root.descriptors) {
		const d = record(item)
		const ctl = d ? control(d.control) : undefined
		if (
			!d ||
			!ctl ||
			typeof d.path !== 'string' ||
			typeof d.label !== 'string' ||
			typeof d.description !== 'string' ||
			typeof d.section !== 'string' ||
			!SECTIONS.includes(d.section)
		)
			continue
		descriptors.push({
			path: d.path,
			label: d.label,
			description: d.description,
			section: d.section as ConfigSettingSection,
			control: ctl,
			...(defaultValue(d.default) !== undefined
				? { default: defaultValue(d.default) as ConfigSettingDefault }
				: {}),
			...(typeof d.defaultNote === 'string' ? { defaultNote: d.defaultNote } : {}),
			...(Array.isArray(d.defaultWhen) ? { defaultWhen: readDefaultWhen(d.defaultWhen) } : {}),
			...(typeof d.defaultText === 'string' ? { defaultText: d.defaultText } : {}),
			...(typeof d.appliesWhen === 'string' && APPLIES_WHEN.includes(d.appliesWhen)
				? { appliesWhen: d.appliesWhen as ConfigSettingAppliesWhen }
				: {}),
			...(typeof d.confirm === 'string' ? { confirm: d.confirm } : {}),
			...(d.confirmWhen === 'on' || d.confirmWhen === 'off' || d.confirmWhen === 'zero'
				? { confirmWhen: d.confirmWhen }
				: {}),
			...(typeof d.confirmValue === 'string' ? { confirmValue: d.confirmValue } : {}),
			...(Array.isArray(d.keywords)
				? { keywords: d.keywords.filter((k): k is string => typeof k === 'string') }
				: {}),
		})
	}
	const settings: ConfigSettingState[] = []
	for (const item of root.settings) {
		const s = record(item)
		if (!s || typeof s.path !== 'string' || typeof s.set !== 'boolean') continue
		settings.push({
			path: s.path,
			set: s.set,
			...(s.set && 'value' in s ? { value: s.value } : {}),
			...(typeof s.layer === 'string' && LAYERS.includes(s.layer)
				? { layer: s.layer as ConfigSettingLayer }
				: {}),
		})
	}
	return { file: typeof root.file === 'string' ? root.file : '', descriptors, settings }
}

export function readConfigSettingChange(value: unknown): ConfigSettingChange {
	const c = record(value)
	if (!c || typeof c.path !== 'string' || c.path.length === 0 || c.path.length > 200)
		throw new Error('Choose a setting.')
	if (Object.keys(c).some((key) => key !== 'path' && key !== 'value'))
		throw new Error('A setting change names only the setting and its value.')
	return { path: c.path, ...(c.value !== undefined && c.value !== null ? { value: c.value } : {}) }
}
