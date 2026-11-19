import { type DesktopSettings, desktopSettingsPatch } from './settings-protocol.js'

/**
 * The engine asks the app to save one of the app's own preferences, after the person said yes on
 * a card. The desktop half of `packages/cli/src/commands/desktop-preferences.ts`: one `namzu/`
 * notification, `{ key, value }`, no answer. The app checks both again here; what the engine may
 * ask for is the list below and nothing else, so a damaged or hostile frame cannot reach any other
 * preference.
 */
export const PREFERENCE_NOTIFICATION = 'namzu/desktop/preference'

/** The preferences the agent may change, the same ones the engine's settings list names. */
export const AGENT_CHANGEABLE_PREFERENCES = [
	'notifyPermission',
	'notifyQuestion',
	'notifyTaskComplete',
	'notifyError',
	'attentionSignals',
	'notificationSound',
	'keepAwakeWhileWorking',
	'keepAwakeOnBattery',
] as const satisfies readonly (keyof DesktopSettings)[]

/** The patch a notification asks for, or `undefined` when it names another key or a bad value. */
export function readPreferenceRequest(value: unknown): Partial<DesktopSettings> | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
	const raw = value as Record<string, unknown>
	if (Object.keys(raw).some((key) => key !== 'key' && key !== 'value')) return undefined
	if (typeof raw.key !== 'string') return undefined
	if (!(AGENT_CHANGEABLE_PREFERENCES as readonly string[]).includes(raw.key)) return undefined
	try {
		return desktopSettingsPatch({ [raw.key]: raw.value })
	} catch {
		return undefined
	}
}
