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
export type ConfigSettingDefault = boolean | number | string | string[] | Record<string, string>

export interface ConfigSettingOption {
	value: string
	label: string
	/** One line saying what choosing it does. */
	help?: string
}

/**
 * Which layer decides the value in force when it is not the user's own file: the project's file,
 * its local file, the administrator's file or an environment variable. The engine fills it; absent
 * means the user file (or the default). An engine older than the field never sends it.
 */
export type ConfigSettingLayer = 'user' | 'project' | 'local' | 'profile' | 'managed' | 'env'

const LAYERS: readonly string[] = ['user', 'project', 'local', 'profile', 'managed', 'env']

export type ConfigSettingControl =
	| { kind: 'toggle' }
	| { kind: 'select'; options: ConfigSettingOption[] }
	| { kind: 'checks'; options: ConfigSettingOption[]; allLabel?: string; emptyNote?: string }
	| { kind: 'toggle-checks'; options: ConfigSettingOption[]; whenOn: string[] }
	| { kind: 'toggle-list'; on: string[]; off: string[] }
	| { kind: 'key'; options: ConfigSettingOption[] }
	| { kind: 'levels'; entries: ConfigSettingOption[]; levels: ConfigSettingOption[] }
	| {
			kind: 'screens'
			options: ConfigSettingOption[]
			passthrough: { screen: string; field: string; label: string; placeholder?: string }
	  }
	| {
			kind: 'list'
			itemLabel: string
			placeholder?: string
			picker?: 'folder'
			source?: 'skills'
	  }
	| { kind: 'number'; min?: number; max?: number; unit?: string }
	| { kind: 'text'; placeholder?: string; picker?: 'folder' }
	| { kind: 'model'; placeholder?: string }
	| { kind: 'routing'; example: string }
	| { kind: 'auto-mode'; lists: ConfigSettingOption[]; example: string }
	| { kind: 'permission-rules'; effects: ConfigSettingOption[]; example: string }
	| {
			kind: 'permission-checks'
			effects: ConfigSettingOption[]
			commandTools: string[]
			commandField: string
			example: string
	  }
	| { kind: 'sites'; levels: ConfigSettingOption[]; defaultLevel: string; example: string }
	| { kind: 'json'; example: string }
	| { kind: 'file-only' }

export interface ConfigSettingDescriptor {
	path: string
	label: string
	description: string
	section: ConfigSettingSection
	/**
	 * The heading the row sits under inside its section, and the words of that heading. Both come
	 * from the engine, so Desktop keeps no list of them. Absent from an engine older than the field:
	 * the row is then drawn above any group, with no heading.
	 */
	group?: string
	groupLabel?: string
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
	confirmWhen?: 'on' | 'off' | 'zero' | 'drops-default' | 'widens' | 'loosens'
	/** For a select, the one new value that asks. Absent: every change asks. */
	confirmValue?: string
	/** For a select with several risky values, each one that asks. A clear asks only if the default is one of them. */
	confirmValues?: string[]
	/** Another setting this one does nothing without; the page warns while it is not `is`. */
	requires?: { path: string; is: string; note: string }
	keywords?: string[]
}

export interface ConfigSettingState {
	path: string
	set: boolean
	/** Never present for a `file-only` setting. */
	value?: unknown
	/** The layer that decides the value in force, when it is not the user file. */
	layer?: ConfigSettingLayer
	/** The value in force from that layer. Absent when the layer's own value is unusable. */
	effective?: unknown
	/** An environment variable the engine has set that is used in place of the saved value. */
	env?: { variable: string; value: string }
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

/** A map (one level for each entry) is a default only for a `levels` control. */
function defaultValue(value: unknown, allowMap = false): ConfigSettingDefault | undefined {
	if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
		return value
	if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
		return value as string[]
	const map = record(value)
	if (allowMap && map && Object.values(map).every((item) => typeof item === 'string'))
		return map as Record<string, string>
	return undefined
}

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

function words(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === 'string')
		? (value as string[])
		: undefined
}

function control(value: unknown): ConfigSettingControl | undefined {
	const c = record(value)
	if (!c) return undefined
	switch (c.kind) {
		case 'toggle':
		case 'file-only':
			return { kind: c.kind }
		case 'select': {
			const list = options(c.options)
			return list ? { kind: 'select', options: list } : undefined
		}
		case 'checks': {
			const list = options(c.options)
			return list
				? {
						kind: 'checks',
						options: list,
						...(typeof c.allLabel === 'string' ? { allLabel: c.allLabel } : {}),
						...(typeof c.emptyNote === 'string' ? { emptyNote: c.emptyNote } : {}),
					}
				: undefined
		}
		case 'toggle-checks': {
			const list = options(c.options)
			const whenOn = words(c.whenOn)
			return list && whenOn ? { kind: 'toggle-checks', options: list, whenOn } : undefined
		}
		case 'toggle-list': {
			const on = words(c.on)
			const off = words(c.off)
			return on && off ? { kind: 'toggle-list', on, off } : undefined
		}
		case 'key': {
			const list = options(c.options)
			return list ? { kind: 'key', options: list } : undefined
		}
		case 'levels': {
			const entries = options(c.entries)
			const levels = options(c.levels)
			return entries && levels ? { kind: 'levels', entries, levels } : undefined
		}
		case 'screens': {
			const list = options(c.options)
			const through = record(c.passthrough)
			if (
				!list ||
				!through ||
				typeof through.screen !== 'string' ||
				typeof through.field !== 'string' ||
				typeof through.label !== 'string'
			)
				return undefined
			return {
				kind: 'screens',
				options: list,
				passthrough: {
					screen: through.screen,
					field: through.field,
					label: through.label,
					...(typeof through.placeholder === 'string' ? { placeholder: through.placeholder } : {}),
				},
			}
		}
		case 'list':
			return typeof c.itemLabel === 'string'
				? {
						kind: 'list',
						itemLabel: c.itemLabel,
						...(typeof c.placeholder === 'string' ? { placeholder: c.placeholder } : {}),
						...(c.picker === 'folder' ? { picker: 'folder' as const } : {}),
						...(c.source === 'skills' ? { source: 'skills' as const } : {}),
					}
				: undefined
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
				...(c.picker === 'folder' ? { picker: 'folder' as const } : {}),
			}
		case 'model':
			return {
				kind: 'model',
				...(typeof c.placeholder === 'string' ? { placeholder: c.placeholder } : {}),
			}
		case 'routing':
			return typeof c.example === 'string' ? { kind: 'routing', example: c.example } : undefined
		case 'auto-mode': {
			const lists = options(c.lists)
			return lists && typeof c.example === 'string'
				? { kind: 'auto-mode', lists, example: c.example }
				: undefined
		}
		case 'permission-rules': {
			const effects = options(c.effects)
			return effects && typeof c.example === 'string'
				? { kind: 'permission-rules', effects, example: c.example }
				: undefined
		}
		case 'permission-checks': {
			const effects = options(c.effects)
			const tools = Array.isArray(c.commandTools) ? c.commandTools : undefined
			return effects &&
				tools &&
				tools.every((tool) => typeof tool === 'string') &&
				typeof c.commandField === 'string' &&
				typeof c.example === 'string'
				? {
						kind: 'permission-checks',
						effects,
						commandTools: tools as string[],
						commandField: c.commandField,
						example: c.example,
					}
				: undefined
		}
		case 'sites': {
			const levels = options(c.levels)
			return levels && typeof c.defaultLevel === 'string' && typeof c.example === 'string'
				? { kind: 'sites', levels, defaultLevel: c.defaultLevel, example: c.example }
				: undefined
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
			// A group needs both its id and its words; one without the other draws no heading.
			...(typeof d.group === 'string' && typeof d.groupLabel === 'string' && d.groupLabel !== ''
				? { group: d.group, groupLabel: d.groupLabel }
				: {}),
			control: ctl,
			...(defaultValue(d.default, ctl.kind === 'levels') !== undefined
				? { default: defaultValue(d.default, ctl.kind === 'levels') as ConfigSettingDefault }
				: {}),
			...(typeof d.defaultNote === 'string' ? { defaultNote: d.defaultNote } : {}),
			...(Array.isArray(d.defaultWhen) ? { defaultWhen: readDefaultWhen(d.defaultWhen) } : {}),
			...(typeof d.defaultText === 'string' ? { defaultText: d.defaultText } : {}),
			...(typeof d.appliesWhen === 'string' && APPLIES_WHEN.includes(d.appliesWhen)
				? { appliesWhen: d.appliesWhen as ConfigSettingAppliesWhen }
				: {}),
			...(typeof d.confirm === 'string' ? { confirm: d.confirm } : {}),
			...(d.confirmWhen === 'on' ||
			d.confirmWhen === 'off' ||
			d.confirmWhen === 'zero' ||
			d.confirmWhen === 'drops-default' ||
			d.confirmWhen === 'widens' ||
			d.confirmWhen === 'loosens'
				? { confirmWhen: d.confirmWhen }
				: {}),
			...(typeof d.confirmValue === 'string' ? { confirmValue: d.confirmValue } : {}),
			...(Array.isArray(d.confirmValues)
				? { confirmValues: d.confirmValues.filter((v): v is string => typeof v === 'string') }
				: {}),
			...(record(d.requires) &&
			typeof record(d.requires)?.path === 'string' &&
			typeof record(d.requires)?.is === 'string' &&
			typeof record(d.requires)?.note === 'string'
				? {
						requires: {
							path: record(d.requires)?.path as string,
							is: record(d.requires)?.is as string,
							note: record(d.requires)?.note as string,
						},
					}
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
			...(typeof s.layer === 'string' && LAYERS.includes(s.layer)
				? { layer: s.layer as ConfigSettingLayer }
				: {}),
			...('effective' in s && s.effective !== undefined && s.effective !== null
				? { effective: s.effective }
				: {}),
			...(record(s.env) &&
			typeof record(s.env)?.variable === 'string' &&
			typeof record(s.env)?.value === 'string'
				? {
						env: {
							variable: record(s.env)?.variable as string,
							value: record(s.env)?.value as string,
						},
					}
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
