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
import { terminalDisplayText } from './terminal-display.js'
import type { TranscriptMessage } from './types.js'

/** Rows kept clear between the redrawable tail and the terminal boundary. */
export const LIVE_WINDOW_SAFETY_ROWS = 6

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
	/** Conservative estimated height of the rows that remain redrawable. */
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
	const content = terminalDisplayText(message.content)
	const meta = message.meta ? terminalDisplayText(message.meta) : ''
	if (raw) {
		return [
			...(hasPrev ? [''] : []),
			`${content}${meta ? ` · ${meta}` : ''}`,
			...(message.detail && message.detail.length > 0
				? ['', ...message.detail.map(terminalDisplayText)]
				: []),
		]
	}
	return [
		...(hasPrev && message.glyph !== '⎿' ? [''] : []),
		`  ${content}`,
		...renderedDetailLines(message),
	]
}

/**
 * Every line the finalized transcript will print, for the live-window height
 * estimate and terminal-safety observers.
 *
 * Exported so the wiring is testable rather than only typecheckable. The caller
 * once counted each row's `content` alone, which made a six-line collapsed tool
 * body look like one line. `/expand` makes that acute: a row whose substance is
 * a two-hundred-line body must not be admitted to a small redrawable viewport.
 *
 * A pending row is excluded because it is not in the static log yet; the
 * pending content is already part of the live region outside this window.
 */
export function transcriptLines(
	messages: readonly TranscriptMessage[],
	raw = false,
): readonly string[] {
	const finalized = messages.filter((m) => !m.pending)
	return finalized.flatMap((message, i) => messageLines(message, i > 0, raw))
}

/**
 * Conservative terminal-cell width.
 *
 * ASCII is one cell. Every printable non-ASCII code point is charged two: that
 * deliberately over-counts combining marks and narrow scripts, but never makes
 * a CJK glyph one cell or relies on UTF-16 string length for terminal geometry.
 * Over-counting settles a row earlier; under-counting can trigger Ink's
 * whole-scrollback repaint path.
 */
function terminalCellWidth(value: string): number {
	let cells = 0
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0
		if (char === '\t') cells += 4
		else if (code >= 0x20 && code !== 0x7f) cells += code <= 0x7e ? 1 : 2
	}
	return cells
}

/**
 * A deliberate over-count of how many terminal rows source lines occupy.
 * Unknown width falls back to a narrow terminal; each source line occupies at
 * least one row, and wrapping is measured in terminal cells rather than code
 * units.
 */
export function estimateRenderedLines(
	transcript: readonly string[],
	columns: number | undefined,
): number {
	const width = Math.max(20, columns ?? 80)
	let total = 0
	for (const entry of transcript) {
		for (const line of entry.split('\n')) {
			total += Math.max(1, Math.ceil(terminalCellWidth(line) / width))
		}
	}
	return total
}

/**
 * Rows added to each windowed row's estimate.
 *
 * Under-count a live row and the window takes more of the viewport than it was
 * budgeted, and the price of exceeding the viewport is the whole-session
 * repaint this window exists to stay clear of. Over-count and the window merely
 * holds one row fewer.
 *
 * Two per row covers what the line estimate cannot see — the rule a code block
 * draws around itself, the blank line markdown puts between blocks — without
 * needing to model any of it.
 */
const ROW_HEIGHT_ALLOWANCE = 2

/**
 * Markdown can add a margin between adjacent blocks even when source blocks
 * are not separated by a blank line. One potential row per non-empty assistant
 * source line is a conservative ceiling on those vertical margins. Detail and
 * non-assistant rows render as plain Text and need no such allowance.
 */
function markdownHeightAllowance(message: TranscriptMessage, raw: boolean): number {
	if (raw || message.role !== 'assistant') return 0
	return message.content.split('\n').filter((line) => line.trim().length > 0).length
}

/** How tall one row is expected to render, rounded UP. */
function messageHeight(
	message: TranscriptMessage,
	hasPrev: boolean,
	columns: number | undefined,
	raw: boolean,
): number {
	return (
		estimateRenderedLines(messageLines(message, hasPrev, raw), columns) +
		ROW_HEIGHT_ALLOWANCE +
		markdownHeightAllowance(message, raw)
	)
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
	const budget = rows - furnitureRows - LIVE_WINDOW_SAFETY_ROWS
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
