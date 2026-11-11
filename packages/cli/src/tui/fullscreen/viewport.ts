/**
 * The fullscreen transcript's viewport: which rows are on screen and what a
 * scroll does to that. Everything here is a pure function over a row index, so
 * the behaviour is driven without a terminal, a layout engine or a clock.
 *
 * The view is anchored to its LAST visible row, not its first. The live region
 * (spinner, composer, footer) is pinned under the transcript and its height
 * moves with pickers and queued messages; the transcript box takes whatever is
 * left and clips from the top, so the bottom row is the one position that
 * stays meaningful when the room changes.
 *
 * The anchor is a message and a row within it rather than a row number. A
 * resize re-wraps every message, so a row number would land somewhere else;
 * the message the reader was looking at is still there.
 */

import { choiceDisplayWidth } from '../terminal-choice-text.js'

/** Where one message's rows start in the flat row list. */
export interface RowIndex {
	/** Message ids, oldest first. */
	readonly ids: readonly string[]
	/** First flat row of each message (its blank separator row comes first). */
	readonly starts: readonly number[]
	/** Rows in all. */
	readonly total: number
	/**
	 * A fingerprint of the newest message. A scrolled-up reader is told about
	 * new activity when it changes; the row count cannot say so because a resize
	 * changes it too.
	 */
	readonly tail: string
}

/** A row in a message: `offset` counts from the message's first row. */
export interface Anchor {
	readonly id: string
	readonly offset: number
}

/**
 * Following the newest row, or holding still on an older one. `seenTail` is the
 * newest message's fingerprint when the reader left the end.
 */
export type ViewState =
	| { readonly follow: true }
	| { readonly follow: false; readonly anchor: Anchor; readonly seenTail: string }

export const FOLLOWING: ViewState = { follow: true }

export type ViewMove = 'page-up' | 'page-down' | 'line-up' | 'line-down' | 'top' | 'bottom'

/** Rows a wheel notch moves. */
export const WHEEL_ROWS = 3

/** Build the index from each message's id and row count, oldest first. */
export function buildRowIndex(
	blocks: readonly { readonly id: string; readonly rows: number; readonly tail?: string }[],
): RowIndex {
	const ids: string[] = []
	const starts: number[] = []
	let total = 0
	for (const block of blocks) {
		ids.push(block.id)
		starts.push(total)
		total += block.rows
	}
	const last = blocks.at(-1)
	return { ids, starts, total, tail: last ? `${last.id}:${last.tail ?? last.rows}` : '' }
}

/** A page is one row less than the window, so the row at the edge stays in view. */
export function pageRows(height: number): number {
	return Math.max(1, Math.floor(height) - 1)
}

/** The last row's index; -1 for an empty transcript. */
export function lastRow(index: RowIndex): number {
	return index.total - 1
}

/**
 * The lowest bottom row that still fills the window: scrolling up never shows a
 * blank band above the first row. A transcript shorter than the window has only
 * its last row.
 */
export function minBottom(index: RowIndex, height: number): number {
	return Math.min(lastRow(index), Math.max(0, Math.floor(height) - 1))
}

function messageAt(index: RowIndex, row: number): number {
	let lo = 0
	let hi = index.starts.length - 1
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1
		if ((index.starts[mid] ?? 0) <= row) lo = mid
		else hi = mid - 1
	}
	return lo
}

/** The anchor that names flat row `row`. */
export function anchorAt(index: RowIndex, row: number): Anchor {
	const at = messageAt(index, Math.min(Math.max(row, 0), Math.max(lastRow(index), 0)))
	return { id: index.ids[at] ?? '', offset: row - (index.starts[at] ?? 0) }
}

/**
 * The flat row of the window's bottom edge. Following is the last row. An
 * anchor whose message is gone (a compaction replaced it) falls back to the end
 * rather than to a row number that now means something else.
 */
export function bottomRow(state: ViewState, index: RowIndex): number {
	if (state.follow || index.total === 0) return lastRow(index)
	const at = index.ids.indexOf(state.anchor.id)
	if (at < 0) return lastRow(index)
	const start = index.starts[at] ?? 0
	const end = (index.starts[at + 1] ?? index.total) - 1
	return Math.min(start + Math.max(0, state.anchor.offset), end)
}

/** The state for a window whose bottom edge is `row`: the end is following. */
export function stateAt(index: RowIndex, row: number, height: number): ViewState {
	const bounded = Math.min(Math.max(row, minBottom(index, height)), lastRow(index))
	if (bounded >= lastRow(index)) return FOLLOWING
	return { follow: false, anchor: anchorAt(index, bounded), seenTail: index.tail }
}

/**
 * Apply a movement. Reaching the end resumes following on its own; there is no
 * separate "stay at the bottom". A move that changes nothing returns the same
 * object, so a caller can skip the update.
 */
export function moveView(
	state: ViewState,
	move: ViewMove,
	index: RowIndex,
	height: number,
	wheelRows = WHEEL_ROWS,
): ViewState {
	if (index.total === 0) return FOLLOWING
	const bottom = bottomRow(state, index)
	let next: number
	switch (move) {
		case 'page-up':
			next = bottom - pageRows(height)
			break
		case 'page-down':
			next = bottom + pageRows(height)
			break
		case 'line-up':
			next = bottom - wheelRows
			break
		case 'line-down':
			next = bottom + wheelRows
			break
		case 'top':
			next = minBottom(index, height)
			break
		case 'bottom':
			return FOLLOWING
	}
	const result = stateAt(index, next, height)
	if (result.follow && state.follow) return state
	if (!result.follow && !state.follow && bottomRow(result, index) === bottom) return state
	return result
}

/**
 * Reconcile the state with the transcript as it is now: the anchor is kept in
 * range after a resize or a compaction, and a window that has reached the end
 * is following again. The same object comes back when nothing changed.
 */
export function syncView(state: ViewState, index: RowIndex, height: number): ViewState {
	if (state.follow) return state
	const bottom = bottomRow(state, index)
	const next = stateAt(index, bottom, height)
	if (next.follow) return next
	if (
		next.follow === false &&
		state.anchor.id === next.anchor.id &&
		state.anchor.offset === next.anchor.offset
	)
		return state
	return { ...next, seenTail: state.seenTail }
}

/** New output arrived below a window the reader scrolled up from. */
export function hasUnseen(state: ViewState, index: RowIndex): boolean {
	return !state.follow && state.seenTail !== index.tail
}

/**
 * The flat rows to draw: at most `limit` of them ending at the bottom edge.
 * The caller draws more than the room it has and lets the box clip the top, so
 * `limit` only has to be an upper bound.
 */
export function visibleRange(
	state: ViewState,
	index: RowIndex,
	limit: number,
): { readonly from: number; readonly to: number } {
	if (index.total === 0) return { from: 0, to: 0 }
	const to = bottomRow(state, index) + 1
	return { from: Math.max(0, to - Math.max(1, Math.floor(limit))), to }
}

const HINT_IDLE = ['↓ Jump to latest · PgDn', '↓ Latest · PgDn', '↓ Latest', '↓'] as const
const HINT_UNSEEN = [
	'New activity · ↓ Jump to latest · PgDn',
	'New activity · ↓ Latest · PgDn',
	'New · ↓ Latest',
	'↓ Latest',
	'↓',
] as const

/**
 * The one row above the composer while scrolled up: the first label that fits,
 * so it shortens before it ever wraps. Null only when not even the arrow fits.
 */
export function jumpHint(columns: number, unseen: boolean): string | null {
	const ladder = unseen ? HINT_UNSEEN : HINT_IDLE
	return ladder.find((label) => choiceDisplayWidth(label) <= columns) ?? null
}

/**
 * Bring flat row `row` into view. A row already in the window leaves the state
 * as it is; otherwise the window moves to put the row about in its middle.
 */
export function revealRow(
	state: ViewState,
	index: RowIndex,
	row: number,
	height: number,
): ViewState {
	if (index.total === 0) return FOLLOWING
	const h = Math.max(1, Math.floor(height))
	const bottom = bottomRow(state, index)
	if (row <= bottom && row > bottom - h) return state
	return stateAt(index, row + Math.floor((h - 1) / 2), h)
}

/** The flat row `offset` rows into message `id`, kept inside the message; null when it is gone. */
export function rowIn(index: RowIndex, id: string, offset: number): number | null {
	const at = index.ids.indexOf(id)
	if (at < 0) return null
	const start = index.starts[at] ?? 0
	const end = (index.starts[at + 1] ?? index.total) - 1
	return Math.min(start + Math.max(0, offset), Math.max(start, end))
}

export interface HoldOptions {
	/** The room the window has, for the clamp at the top. */
	readonly height: number
	/** Rows under the last row of text now: the jump hint or the search line. */
	readonly footer: number
	/** The search line stays whatever the window does. */
	readonly searching: boolean
}

/**
 * The state that keeps one row where the reader sees it when the message it
 * belongs to changes height. `before` and `after` are the rows before and
 * after, and the row is named by its message and its place in it. Rows above
 * the message did not change, so the rows between the row and the window's
 * bottom edge are what is held.
 *
 * A window that was following keeps following only if the end is still within
 * reach of that edge; otherwise it stops, as it does when the reader scrolls up,
 * and the jump hint's row is counted, because it takes a row of the window.
 */
export function holdRow(
	state: ViewState,
	before: RowIndex,
	after: RowIndex,
	id: string,
	offset: number,
	options: HoldOptions,
): ViewState {
	const was = rowIn(before, id, offset)
	const now = rowIn(after, id, offset)
	if (was === null || now === null) return syncView(state, after, options.height)
	// Screen rows under the row, the footer included.
	const below = bottomRow(state, before) - was + options.footer
	const pinned = options.searching ? 1 : 0
	if (now + below - pinned >= lastRow(after)) return FOLLOWING
	return stateAt(after, now + below - 1, options.height)
}
