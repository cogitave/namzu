import { tabChord } from './tab-keys.js'

/**
 * What a key chord means inside a terminal view.
 *
 * Almost every chord belongs to the program in the terminal, including the ones the rest of the app
 * uses (Ctrl+K, Ctrl+N, Escape). The exceptions are few and named: copy and paste, find, and the
 * chords that open another terminal or settings and the ones that move between tabs.
 */
export type TerminalKeyAction =
	/** Copy the selection. */
	| 'copy'
	/** Let the browser paste into the terminal's input. */
	| 'paste'
	/** Open the find bar. */
	| 'find'
	/** The application's own chord: not for the program, and it must reach the window. */
	| 'app'
	/** Leave it to the program. */
	| 'send'

export interface TerminalKeyEvent {
	key: string
	code: string
	ctrlKey: boolean
	metaKey: boolean
	shiftKey: boolean
	altKey: boolean
}

/** Chords that belong to the window and never reach the program: tabs, settings, another terminal. */
export function isTerminalAppChord(event: TerminalKeyEvent, mac: boolean): boolean {
	if (tabChord(event, { mac, inTerminal: true })) return true
	const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
	if (!primary || event.altKey) return false
	const key = event.key.toLowerCase()
	if (event.shiftKey) return event.code === 'Backquote' || key === '`' || key === '~'
	return key === ',' || event.code === 'Comma'
}

export function terminalKeyAction(
	event: TerminalKeyEvent,
	state: { hasSelection: boolean; mac: boolean },
): TerminalKeyAction {
	if (isTerminalAppChord(event, state.mac)) return 'app'
	const primary = state.mac ? event.metaKey : event.ctrlKey
	if (!primary || event.altKey) return 'send'
	if (state.mac ? event.ctrlKey : event.metaKey) return 'send'
	const key = event.key.toLowerCase()
	if (event.shiftKey && (event.code === 'Backquote' || key === '`' || key === '~')) return 'app'
	if (key === 'c') {
		// Ctrl+C is the interrupt unless there is something selected to copy; Ctrl+Shift+C is always a copy.
		if (state.mac) return event.shiftKey ? 'send' : state.hasSelection ? 'copy' : 'send'
		return event.shiftKey || state.hasSelection ? 'copy' : 'send'
	}
	if (key === 'v') return state.mac && event.shiftKey ? 'send' : 'paste'
	if (key === 'f' && !event.shiftKey) return 'find'
	return 'send'
}
