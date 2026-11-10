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

export interface ConfigSettingOption {
	value: string
	label: string
}

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
	defaultText?: string
	confirm?: string
	/** Which new value asks: `on`/`off` for a toggle, `zero` for a cap. Absent: every change asks. */
	confirmWhen?: 'on' | 'off' | 'zero'
	keywords?: string[]
}

export interface ConfigSettingState {
	path: string
	set: boolean
	/** Never present for a `file-only` setting. */
	value?: unknown
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
		out.push({ value: entry.value, label: entry.label })
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
			...(typeof d.defaultText === 'string' ? { defaultText: d.defaultText } : {}),
			...(typeof d.confirm === 'string' ? { confirm: d.confirm } : {}),
			...(d.confirmWhen === 'on' || d.confirmWhen === 'off' || d.confirmWhen === 'zero'
				? { confirmWhen: d.confirmWhen }
				: {}),
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
