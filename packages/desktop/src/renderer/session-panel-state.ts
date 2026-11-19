const KEY = 'namzu.session-panel-open'

/**
 * Whether the person left the session panel open. A window-wide choice kept in this browser only; a
 * window that has never been asked keeps it closed, so the conversation keeps its full width until the
 * person turns the panel on.
 */
export function readSessionPanelOpen(storage: Pick<Storage, 'getItem'> | undefined): boolean {
	try {
		return storage?.getItem(KEY) === '1'
	} catch {
		return false
	}
}

export function writeSessionPanelOpen(
	storage: Pick<Storage, 'setItem'> | undefined,
	open: boolean,
): void {
	try {
		storage?.setItem(KEY, open ? '1' : '0')
	} catch {
		// A blocked store only means the choice is not remembered.
	}
}
