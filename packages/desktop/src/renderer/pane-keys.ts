import type { GridKind } from './pane-grid.js'

export interface PaneKeyEvent {
	key: string
	code: string
	ctrlKey: boolean
	metaKey: boolean
	shiftKey: boolean
	altKey: boolean
}

/**
 * The pane a key chord toggles, if any: Terminal on Ctrl+' (Cmd on a Mac), Browser on Ctrl+Shift+B and
 * Files on Ctrl+Shift+F. Changes and the Session pane have no key. Plain Ctrl+B stays the sidebar's and
 * plain Ctrl+F stays find, so each of these needs the Shift or the quote it names.
 */
export function paneChord(event: PaneKeyEvent, mac: boolean): GridKind | undefined {
	const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
	if (!primary || event.altKey) return undefined
	if (!event.shiftKey) return event.code === 'Quote' || event.key === "'" ? 'terminal' : undefined
	if (event.code === 'KeyB') return 'browser'
	if (event.code === 'KeyF') return 'files'
	return undefined
}
