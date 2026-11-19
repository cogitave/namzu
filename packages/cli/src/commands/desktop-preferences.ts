import { readFileSync } from 'node:fs'
import type { DesktopPreferences } from '../config/agent-settings.js'

/**
 * Asks the Desktop app to save one of its own preferences, sent as a `namzu/` notification on the
 * stream the app already listens to. The app checks the key and the value again and says nothing
 * back: what it saves shows in Settings at once.
 */
export const DESKTOP_PREFERENCE_NOTIFICATION = 'namzu/desktop/preference'

/** The variable the app sets to the file its preferences are saved in. The engine only reads it. */
export const DESKTOP_SETTINGS_FILE_VARIABLE = 'NAMZU_DESKTOP_SETTINGS_FILE'

/**
 * How the engine reaches the Desktop app's preferences, or `undefined` when the app did not say
 * where they are (then the settings tools do not offer those rows at all).
 */
export function desktopPreferencesBridge(
	env: NodeJS.ProcessEnv,
	notify: (method: string, params: Record<string, unknown>) => void,
): DesktopPreferences | undefined {
	const file = env[DESKTOP_SETTINGS_FILE_VARIABLE]
	if (!file) return undefined
	return {
		read() {
			try {
				const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
				return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: undefined
			} catch (cause) {
				// A file that is not there yet means the app has saved nothing: every default holds.
				return (cause as NodeJS.ErrnoException).code === 'ENOENT' ? {} : undefined
			}
		},
		write(key, value) {
			notify(DESKTOP_PREFERENCE_NOTIFICATION, { key, value })
		},
	}
}
