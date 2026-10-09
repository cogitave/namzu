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
