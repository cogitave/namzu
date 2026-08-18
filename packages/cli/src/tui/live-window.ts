/**
 * How much of the transcript is still ALIVE — redrawable — and how much has
 * already been handed to the terminal's own scrollback.
 *
 * ## Why there is a window at all
 *
 * Every finalized row used to go straight into `<Static>`, which prints a row
 * once and never redraws it. That kept per-frame work bounded, and it also made
 * changing a row that is already on screen impossible by construction: an
 * expand key could not reopen a collapsed body, so expansion had to become a
 * command that appends a second copy of the output further down.
 *
 * A small window of the most recent rows is kept live instead. Inside it a row
 * can be redrawn in place, so expansion works where an operator actually looks;
 * `/expand <n>` remains the way to reach anything older, and the hint under a
 * collapsed body already degrades correctly when a row has no number.
 *
 * ## Why the window is bounded by HEIGHT, not by a count of rows
 *
 * This is the constraint the whole design turns on, and it is a property of the
 * renderer rather than a preference. When the live region's height reaches the
 * viewport's, ink stops doing an incremental repaint and instead writes
 * `clearTerminal` followed by **the entire static output it has accumulated
 * this session** plus the frame. On a long session that is the whole transcript,
 * re-serialized on every spinner tick — which is the allocation churn that
 * pushed `<Static>` to swallow everything in the first place.
 *
 * So the window takes rows from the end only while their estimated height fits
 * a budget the live furniture and a safety margin are already subtracted from.
 * A single row taller than the budget leaves the window empty, and an empty
 * window is exactly the previous behaviour — the failure direction is "no
 * retroactive expansion", never "repaint the session".
 *
 * ## Why it only ever moves one way
 *
 * `settled` is a floor the caller carries between renders. `<Static>` keeps an
 * index of how many items it has emitted and renders only what is past it, so a
 * shrinking item list would leave rows unprinted; and a row that has already
 * been drawn live must not be handed back to a mechanism that would print it
 * again. Rows therefore leave the window in one direction, oldest first, and a
 * row that has settled never comes back.
 */

import { renderedDetailLines } from './Transcript.js'
import { SAFETY_ROWS, estimateRenderedLines } from './bottom-spacer.js'
import type { TranscriptMessage } from './types.js'

/**
 * The most rows the window will ever hold, whatever the terminal's height.
 *
 * A cap on top of the height budget, because the budget alone would put thirty
 * short rows in the live region on a tall terminal — thirty rows re-laid-out
 * per spinner tick to make retroactive expansion available on output nobody is
 * still looking at. Six covers what an operator is working with: a tool call,
 * its result, and the exchange around them.
 */
export const MAX_LIVE_ROWS = 6

export interface LiveWindowInput {
	/** Finalized rows, oldest first. The pending row is not one of these. */
	readonly messages: readonly TranscriptMessage[]
	/** Terminal height. `undefined` when not a TTY. */
	readonly rows: number | undefined
	/** Terminal width, for wrapping. `undefined` falls back to 80. */
	readonly columns: number | undefined
	/** Rows the live region occupies apart from the window: activity, composer, status bar. */
	readonly furnitureRows: number
	/** How many rows have already settled into scrollback. The window never reaches back past this. */
	readonly settled: number
	/** Plain source mode prints complete detail bodies and has no glyph gutter. */
	readonly raw?: boolean
}

export interface LiveWindow {
	/** `messages[0, settled)` are in scrollback; the rest are drawn live. */
	readonly settled: number
	/** The live rows' estimated height, for the bottom spacer to account for. */
	readonly rows: number
}

/**
 * Every line one row will print, including the body under a tool call.
 *
 * The blank row `MessageRow` puts above every entry but the first and the `⎿`
 * result rows is counted, because one row per entry is not negligible: forty
 * entries is forty rows, which on most terminals is the whole viewport. The
 * content is indented by the two-column glyph gutter it renders beside, so a
 * long line is measured against the width it actually has.
 */
function messageLines(message: TranscriptMessage, hasPrev: boolean, raw: boolean): string[] {
	if (raw) {
		return [
			...(hasPrev ? [''] : []),
			`${message.content}${message.meta ? ` · ${message.meta}` : ''}`,
			...(message.detail && message.detail.length > 0 ? ['', ...message.detail] : []),
		]
	}
	return [
		...(hasPrev && message.glyph !== '⎿' ? [''] : []),
		`  ${message.content}`,
		...renderedDetailLines(message),
	]
}

/**
 * Every line the finalized transcript will print, for a height estimate.
 *
 * Exported so the wiring is testable rather than only typecheckable. The
 * spacer's own docblock states the asymmetry it depends on: over-count the
 * content and the composer merely floats, under-count it and the composer is
 * pushed off the bottom. The caller used to pass each row's `content` alone,
 * which counted a six-line collapsed tool body as nothing at all — the estimate
 * ran low by six per tool call, in the direction that costs the usability
 * rather than the feature. `/expand` makes it acute: a row whose entire
 * substance is a two-hundred-line body would have been handed over as one line.
 *
 * A pending row is excluded because it is not in the static log yet; the
 * spacer's `liveRows` covers the live region.
 */
export function transcriptLines(
	messages: readonly TranscriptMessage[],
	raw = false,
): readonly string[] {
	const finalized = messages.filter((m) => !m.pending)
	return finalized.flatMap((message, i) => messageLines(message, i > 0, raw))
}

/**
 * Rows added to each windowed row's estimate.
 *
 * `estimateRenderedLines` is deliberately an UNDER-count, because for the
 * bottom spacer counting low leaves more apparent room and the safety margin
 * absorbs the difference. Here the asymmetry runs the other way: under-count a
 * live row and the window takes more of the viewport than it was budgeted, and
 * the price of exceeding the viewport is the whole-session repaint this window
 * exists to stay clear of. Over-count and the window merely holds one row
 * fewer.
 *
 * Two per row covers what the line estimate cannot see — the rule a code block
 * draws around itself, the blank line markdown puts between blocks — without
 * needing to model any of it.
 */
const ROW_HEIGHT_ALLOWANCE = 2

/** How tall one row is expected to render, rounded UP. */
function messageHeight(
	message: TranscriptMessage,
	hasPrev: boolean,
	columns: number | undefined,
	raw: boolean,
): number {
	return estimateRenderedLines(messageLines(message, hasPrev, raw), columns) + ROW_HEIGHT_ALLOWANCE
}

/**
 * How much of the transcript stays live, given the room there is for it.
 *
 * Returns `settled === messages.length` — everything in scrollback, nothing
 * redrawable — whenever the answer is not knowable: no TTY, an implausible
 * height, or a most-recent row too tall to hold. That is the previous
 * behaviour, and it is the safe direction.
 */
export function liveWindow(input: LiveWindowInput): LiveWindow {
	const { messages, rows, columns, furnitureRows, settled, raw = false } = input
	const floor = Math.min(Math.max(settled, 0), messages.length)

	if (rows === undefined || !Number.isFinite(rows)) return { settled: messages.length, rows: 0 }
	const budget = rows - furnitureRows - SAFETY_ROWS
	if (budget < 1) return { settled: messages.length, rows: 0 }

	let height = 0
	let held = 0
	for (let i = messages.length - 1; i >= floor && held < MAX_LIVE_ROWS; i--) {
		const message = messages[i]
		if (!message) break
		const next = height + messageHeight(message, i > 0, columns, raw)
		if (next > budget) break
		height = next
		held += 1
	}
	return { settled: messages.length - held, rows: height }
}
