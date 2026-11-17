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
	if (typeof value === 'number')
		return control.kind === 'number' && control.unit ? `${value} ${control.unit}` : String(value)
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

/**
 * A number field's text to the number sent, or the sentence to show. The engine checks the same
 * bounds again; this only stops a request that cannot be right.
 */
export function numberFromText(
	text: string,
	control: { min?: number; max?: number },
): { value: number } | { error: string } {
	const trimmed = text.trim()
	if (trimmed === '' || !Number.isFinite(Number(trimmed))) return { error: 'Enter a number.' }
	const value = Number(trimmed)
	if (control.min !== undefined && value < control.min)
		return { error: `Enter ${control.min} or more.` }
	if (control.max !== undefined && value > control.max)
		return { error: `Enter ${control.max} or less.` }
	return { value }
}

/** Search entries for every engine setting, so the page's search finds them with the rest. */
export function configSearchEntries(view: ConfigSettingsView | undefined): SettingsEntry[] {
	if (!view) return []
	return view.descriptors.map((d) => ({
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
