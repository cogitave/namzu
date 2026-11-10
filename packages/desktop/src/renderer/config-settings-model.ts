import type {
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

/** What a switch shows while nothing is saved: the engine's default, written in words. */
export function defaultToggle(descriptor: ConfigSettingDescriptor): boolean {
	return descriptor.defaultText?.trim().toLowerCase().startsWith('on') ?? false
}

export function defaultNote(descriptor: ConfigSettingDescriptor): string {
	return descriptor.defaultText ? `Default: ${descriptor.defaultText}.` : ''
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
