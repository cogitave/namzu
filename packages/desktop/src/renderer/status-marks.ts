import { useEffect, useSyncExternalStore } from 'react'
import type { ConfigSettingsView } from '../shared/config-settings-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'

/** The setting's path in the engine's config file. */
export const STATUS_MARKS_PATH = 'statusMarks'

/** Whether the sidebar marks conversations. On unless the setting says off. */
export function statusMarksFrom(view: ConfigSettingsView | undefined): boolean {
	const state = view?.settings.find((entry) => entry.path === STATUS_MARKS_PATH)
	const value = state?.effective !== undefined ? state.effective : state?.value
	return value !== false
}

// One value for the window: every row reads it, and the app sets it from the saved settings.
let marks = true
const listeners = new Set<() => void>()

export function setStatusMarks(next: boolean): void {
	if (marks === next) return
	marks = next
	for (const listener of listeners) listener()
}

/** What a conversation row reads: false hides its status mark. */
export function useStatusMarks(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		() => marks,
		() => marks,
	)
}

/**
 * Keeps the window's value current: read once, again when the window takes focus, and when main
 * says the config file changed (a save in Settings lands there). A failed read leaves what was
 * shown.
 */
export function useStatusMarksSetting(
	api: Pick<DesktopApi, 'configSettings'> & Partial<Pick<DesktopApi, 'onEvent'>>,
): void {
	useEffect(() => {
		if (!api.configSettings) return
		let live = true
		const read = () => {
			void api.configSettings?.().then(
				(view) => {
					if (live) setStatusMarks(statusMarksFrom(view))
				},
				() => undefined,
			)
		}
		read()
		window.addEventListener('focus', read)
		const stop = api.onEvent?.((event) => {
			if (event.kind === 'config-file-changed') read()
		})
		return () => {
			live = false
			window.removeEventListener('focus', read)
			stop?.()
		}
	}, [api])
}
