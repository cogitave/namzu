/** The sections of the Settings dialog. Apart from the protocol so the catalogue can list them without a cycle. */
export const SETTINGS_SECTIONS = [
	'general',
	'models',
	'usage',
	'agent',
	'tools',
	'extensions',
	'projects',
	'appearance',
	'notifications',
	'terminal',
	'desktop',
	'privacy',
	'telemetry',
	'updates',
	'speech',
	'about',
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export function isSettingsSection(value: unknown): value is SettingsSection {
	return typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value)
}
