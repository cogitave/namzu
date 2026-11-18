/**
 * The details column's view state. On a window this wide it is its own 320 px column between the
 * conversation and the side panel; on a narrower one the same body is a tab of the side panel, so it
 * never takes a third column from a window that has no room for one.
 */
export const DETAILS_COLUMN_MIN_WINDOW = 1500
export const DETAILS_COLUMN_QUERY = `(min-width: ${DETAILS_COLUMN_MIN_WINDOW}px)`
export const DETAILS_COLUMN_WIDTH = 320

const KEY = 'namzu.details-column'

export function readDetailsColumn(storage: Pick<Storage, 'getItem'>): boolean {
	try {
		return storage.getItem(KEY) === '1'
	} catch {
		return false
	}
}

export function writeDetailsColumn(storage: Pick<Storage, 'setItem'>, on: boolean): void {
	try {
		storage.setItem(KEY, on ? '1' : '0')
	} catch {
		// Storage can be blocked; the choice then lasts for this session only.
	}
}

/** What the title bar's details button does: flip the column, or open or close the pane's Details tab. */
export function detailsToggleAction(state: {
	wide: boolean
	/** The pane (the side panel) is open and showing the Details tab now. */
	pane: boolean
}): 'column' | 'pane-open' | 'pane-close' {
	if (state.wide) return 'column'
	return state.pane ? 'pane-close' : 'pane-open'
}
