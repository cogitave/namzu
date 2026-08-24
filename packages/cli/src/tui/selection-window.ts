/** Default number of finite choices kept visible in terminal overlays. */
export const SELECTION_WINDOW_SIZE = 7

export interface SelectionWindow<T> {
	readonly start: number
	readonly items: readonly T[]
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
