import type { DesktopApi } from '../shared/protocol.js'
import { TerminalSession, type TerminalSessionApi, TerminalSessions } from './terminal-session.js'
import { terminalFontFamily, terminalTheme } from './terminal-theme.js'

const FONT_SIZE = 13

const read = (name: string): string =>
	getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const isDark = (): boolean => document.documentElement.classList.contains('dark')
const isMac = (): boolean => /Mac/.test(navigator.platform)

/** The desktop API as a terminal view needs it, or undefined where there is no host for terminals. */
export function terminalApi(api: Partial<DesktopApi> | undefined): TerminalSessionApi | undefined {
	if (
		!api?.attachTerminal ||
		!api.detachTerminal ||
		!api.writeTerminal ||
		!api.resizeTerminal ||
		!api.onTerminalEvent
	)
		return undefined
	return api as TerminalSessionApi
}

declare global {
	interface Window {
		/** Present only when `localStorage['namzu.terminal.debug']` is `1`: reads a terminal's screen for tests. */
		__namzuTerminals?: {
			text(tabId: string): string | undefined
			size(tabId: string): { cols: number; rows: number } | undefined
			ids(): string[]
		}
	}
}

const registries = new WeakMap<object, TerminalSessions>()
let findOpener: ((tabId: string) => void) | undefined

/** The pane registers how its find bar opens, so a key chord inside a terminal can reach it. */
export function onTerminalFind(open: ((tabId: string) => void) | undefined): void {
	findOpener = open
}

/** The window's terminal sessions. One registry per API object, shared by every pane. */
export function terminalSessions(api: TerminalSessionApi): TerminalSessions {
	let sessions = registries.get(api)
	if (sessions) return sessions
	const created = new TerminalSessions((tabId) => {
		return new TerminalSession(api, tabId, {
			theme: terminalTheme(read, isDark()),
			fontFamily: terminalFontFamily(read),
			fontSize: FONT_SIZE,
			mac: isMac(),
			onFind: () => findOpener?.(tabId),
		})
	})
	sessions = created
	registries.set(api, sessions)
	// The appearance is a class on the root: every terminal follows it.
	const observer = new MutationObserver(() => {
		const theme = terminalTheme(read, isDark())
		created.each((session) => session.setTheme(theme))
	})
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
	try {
		if (localStorage.getItem('namzu.terminal.debug') === '1') {
			window.__namzuTerminals = {
				text: (tabId) => created.peek(tabId)?.text(),
				size: (tabId) => {
					const term = created.peek(tabId)?.term
					return term ? { cols: term.cols, rows: term.rows } : undefined
				},
				ids: () => {
					const ids: string[] = []
					created.each((session) => ids.push(session.tabId))
					return ids
				},
			}
		}
	} catch {
		/* Storage can be unavailable; the hook is for tests only. */
	}
	return sessions
}
