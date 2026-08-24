/** Default number of finite choices kept visible in terminal overlays. */
export const SELECTION_WINDOW_SIZE = 7

export type SelectionMovement =
	| 'previous'
	| 'next'
	| 'previous-page'
	| 'next-page'
	| 'first'
	| 'last'

export interface SelectionWindow<T> {
	readonly start: number
	readonly items: readonly T[]
}

/** Move an absolute finite-list cursor without letting a UI invent its own page size. */
export function moveSelection(
	selected: number,
	itemCount: number,
	movement: SelectionMovement,
	pageSize = SELECTION_WINDOW_SIZE,
): number {
	if (itemCount <= 0) return 0
	const current = Math.max(0, Math.min(selected, itemCount - 1))
	switch (movement) {
		case 'previous':
			return Math.max(0, current - 1)
		case 'next':
			return Math.min(itemCount - 1, current + 1)
		case 'previous-page':
			return Math.max(0, current - Math.max(1, pageSize))
		case 'next-page':
			return Math.min(itemCount - 1, current + Math.max(1, pageSize))
		case 'first':
			return 0
		case 'last':
			return itemCount - 1
	}
}

/**
 * Keep an absolute selection inside a bounded, centred terminal window.
 *
 * The cursor remains in the caller's full-list coordinate space. Returning
 * the absolute start beside the slice prevents a rendered row from being
 * submitted as the wrong item after the first page scrolls away.
 */
export function selectionWindow<T>(
	items: readonly T[],
	selected: number,
	windowSize = SELECTION_WINDOW_SIZE,
): SelectionWindow<T> {
	if (items.length === 0 || windowSize <= 0) return { start: 0, items: [] }
	const clamped = Math.max(0, Math.min(selected, items.length - 1))
	const start = Math.max(
		0,
		Math.min(clamped - Math.floor(windowSize / 2), items.length - windowSize),
	)
	return { start, items: items.slice(start, start + windowSize) }
}
