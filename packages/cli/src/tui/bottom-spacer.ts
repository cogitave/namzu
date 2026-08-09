/**
 * How many blank rows to put above the composer so it sits at the bottom.
 *
 * ## The narrow defect
 *
 * Ink writes the transcript to native scrollback via `<Static>` and re-renders
 * the live region — activity, composer, status bar — beneath it. Once the
 * output exceeds the viewport the terminal has scrolled, and the composer is
 * already at the bottom. The complaint is entirely the case before that: five
 * lines on a forty-row terminal leaves the composer at row six with blank space
 * under it, and the operator's eye has to find it.
 *
 * So this does not try to pin the composer always. It pads only while the
 * transcript is unambiguously shorter than the viewport, and returns 0 the
 * moment that stops being knowable. After that, the terminal does it.
 *
 * ## Why a rough estimate is safe here, and would not be in general
 *
 * The rendered height of a transcript is not knowable from this side: ink does
 * not report it, and wrapping depends on ANSI, wide glyphs and markdown that
 * this module does not model. That is exactly why the whole-session version of
 * this idea is a bad one.
 *
 * It is safe in the short case because the error is **asymmetric**:
 *
 * - Overestimate the content ⇒ pad less, or not at all ⇒ the composer floats,
 *   which is precisely today's behaviour. No worse than not doing this.
 * - Underestimate the content ⇒ pad too much ⇒ the composer is pushed off the
 *   bottom, which is worse than today.
 *
 * So every uncertainty is resolved toward *more* content and *less* padding:
 * `estimateRenderedLines` counts a minimum, {@link SAFETY_ROWS} is subtracted
 * on top, and anything unknown returns 0. Being wrong costs the feature, never
 * the usability.
 */

/**
 * Rows held back from the calculation.
 *
 * Absorbs what the estimate cannot see — a wrapped line the width maths missed,
 * a wide glyph, a markdown block that renders taller than its source. Six is
 * chosen to be visibly generous rather than tuned: the cost of it being too
 * large is a small gap under the composer on a nearly-empty screen, and the
 * cost of it being too small is a composer pushed out of view.
 */
export const SAFETY_ROWS = 6

export interface SpacerInput {
	/** Terminal height. `undefined` when not a TTY. */
	readonly rows: number | undefined
	/** Terminal width, for wrapping. `undefined` falls back to 80. */
	readonly columns: number | undefined
	/**
	 * The finalized transcript lines, as emitted — before ink renders them.
	 *
	 * Every line a row will print, including the collapsed body under a tool
	 * call. The caller used to pass each row's `content` alone, which counted an
	 * eight-row tool result as one row: the estimate then ran low by seven, and
	 * the asymmetry above says exactly what running low costs. `/expand` makes a
	 * row whose whole substance is its body, so a caller that passed content
	 * alone would hand a two-hundred-line row over as a single line.
	 */
	readonly transcript: readonly string[]
	/** Rows the live region occupies: activity, composer frame, status bar. */
	readonly liveRows: number
}

/**
 * A deliberate UNDER-count of how tall the transcript will render.
 *
 * Under, not over, because it is subtracted from the space available: counting
 * low leaves more apparent room, and the safety margin plus the guard below are
 * what stop that becoming padding. Each entry is at least one row, and a long
 * entry is divided by the width to approximate wrapping.
 */
export function estimateRenderedLines(
	transcript: readonly string[],
	columns: number | undefined,
): number {
	const width = Math.max(20, columns ?? 80)
	let total = 0
	for (const entry of transcript) {
		for (const line of entry.split('\n')) {
			total += Math.max(1, Math.ceil(line.length / width))
		}
	}
	return total
}

/**
 * Blank rows to insert above the composer, or 0 to leave the layout alone.
 *
 * Returns 0 whenever the answer could be wrong: no TTY, an implausible height,
 * or a transcript long enough that the terminal has plausibly begun to scroll.
 */
export function bottomSpacerRows(input: SpacerInput): number {
	const { rows, columns, transcript, liveRows } = input

	// Not a terminal, or a height too small to reason about. A pipe has no
	// bottom to pin to.
	if (rows === undefined || !Number.isFinite(rows) || rows < 12) return 0

	const used = estimateRenderedLines(transcript, columns) + liveRows + SAFETY_ROWS

	// The transcript is at or past the viewport: the terminal is scrolling and
	// the composer is already where it should be. Padding now would push it off.
	if (used >= rows) return 0

	return rows - used
}
