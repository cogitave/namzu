/**
 * The details column's view state. On a window this wide it is its own 320 px column between the
 * conversation and the side panel; on a narrower one the same body is a tab of the side panel, so it
 * never takes a third column from a window that has no room for one.
 */
export const DETAILS_COLUMN_MIN_WINDOW = 1500
export const DETAILS_COLUMN_QUERY = `(min-width: ${DETAILS_COLUMN_MIN_WINDOW}px)`
export const DETAILS_COLUMN_WIDTH = 320
/**
 * The column also needs room in the workspace itself: with a reading panel (60 percent of what the column
 * leaves) beside it, the conversation keeps 40 percent of the rest, so 360 px of transcript needs
 * (360 / 0.4) + 320 = 1220 px. Below that the column steps aside and the details are the pane's tab.
 */
export const DETAILS_COLUMN_MIN_WORKSPACE = 1220

export function detailsColumnFits(workspaceWidth: number): boolean {
	return workspaceWidth >= DETAILS_COLUMN_MIN_WORKSPACE
}

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
	/** The column is on screen now. */
	column: boolean
	/** The pane (the side panel) is open and showing the Details tab now. */
	pane: boolean
}): 'column' | 'pane-open' | 'pane-close' {
	// A pane tab left open while the window grew is closed by "hide", not swapped for the column.
	if (state.wide) return state.pane && !state.column ? 'pane-close' : 'column'
	return state.pane ? 'pane-close' : 'pane-open'
}
