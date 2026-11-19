/**
 * What the system itself says about the rows it applies, read back by the main process. The page
 * draws a switch from this, not only from the saved wish, so a change the system refused or a
 * login item removed in the system's own list shows as it really is.
 */
export type MeteredState = 'metered' | 'unmetered' | 'unknown'

export interface ShortcutState {
	registered: boolean
	problem?: string
}

export interface OsState {
	/** `process.platform` of the running app. */
	platform: string
	/** Absent where Namzu cannot start by itself at login (an app run from source, another system). */
	loginItem?: { enabled: boolean; problem?: string }
	/** Whether the tray icon is up; `problem` says why not when it was asked for. */
	tray: { shown: boolean; problem?: string }
	/** Whether each global shortcut is held; `problem` says why not when it was asked for. */
	shortcuts?: { quickEntry: ShortcutState; voice: ShortcutState }
	/** Absent where Namzu cannot read the connection's cost. */
	metered?: { state: MeteredState }
}

/** The line under the low-data row: what the system answered, in words. */
export function meteredLine(state: MeteredState): string {
	if (state === 'metered') return 'This connection is metered right now, so these downloads wait.'
	if (state === 'unmetered') return 'This connection is not metered.'
	return 'Namzu cannot tell whether this connection is metered, so nothing waits.'
}

/** What the system calls the tray: the menu bar on macOS. */
export function trayName(platform: string): string {
	return platform === 'darwin' ? 'Menu bar' : 'System tray'
}
