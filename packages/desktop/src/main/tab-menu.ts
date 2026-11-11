import type { TabCommand } from '../shared/protocol.js'

export interface TabMenuItem {
	label: string
	accelerator: string
	/**
	 * Windows and Linux: show the shortcut but let the key reach the window, which runs the same
	 * action itself. With a registered accelerator the menu would take Ctrl+W before a focused
	 * terminal could hand it on, and a press could run the action twice.
	 */
	registerAccelerator: boolean
	click: () => void
}

/** The File menu's tab entries. Each one asks the focused window to run its own tab action. */
export function tabMenuItems(
	platform: NodeJS.Platform,
	send: (command: TabCommand) => void,
): TabMenuItem[] {
	const registered = platform === 'darwin'
	return [
		{ label: 'Close tab', accelerator: 'CmdOrCtrl+W', command: 'close' as const },
		{ label: 'Next tab', accelerator: 'Ctrl+Tab', command: 'next' as const },
		{ label: 'Previous tab', accelerator: 'Ctrl+Shift+Tab', command: 'previous' as const },
	].map(({ label, accelerator, command }) => ({
		label,
		accelerator,
		registerAccelerator: registered,
		click: () => send(command),
	}))
}

/** The id of the View menu's tab-strip switch, so a change made in Settings can find it. */
export const SHOW_TABS_MENU_ID = 'show-conversation-tabs'

/** The View menu's switch for the strip of conversation tabs. It keeps what Settings keeps. */
export function showTabsMenuItem(
	checked: boolean,
	change: (show: boolean) => void,
): {
	id: string
	label: string
	type: 'checkbox'
	checked: boolean
	click: (item: { checked: boolean }) => void
} {
	return {
		id: SHOW_TABS_MENU_ID,
		label: 'Show conversation tabs',
		type: 'checkbox',
		checked,
		click: (item) => change(item.checked),
	}
}
