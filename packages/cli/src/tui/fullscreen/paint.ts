/**
 * A row with some of its cells drawn differently: a selection, a search match.
 * The styling of the row stays; the marked cells are changed on top of it.
 */

import { cellsOf } from './cells.js'
import type { FsRow, StyledSpan } from './rows.js'

/** Cells `[from, to)` of a row, and how they are drawn. */
export interface Mark {
	readonly from: number
	readonly to: number
	readonly style: Pick<StyledSpan, 'inverse' | 'bold' | 'underline'>
}

/** The row's spans, the way it is drawn when it has none of its own. */
export function rowSpans(row: FsRow): readonly StyledSpan[] {
	return (
		row.spans ?? [
			{
				text: row.text,
				color: row.color,
				...(row.tint !== undefined ? { background: row.tint } : {}),
			},
		]
	)
}

/**
 * The row's spans with `marks` laid over them. Where marks overlap, the later
 * one wins. Spans that no mark touches come back as they were.
 */
export function paintRow(row: FsRow, marks: readonly Mark[]): readonly StyledSpan[] {
	const spans = rowSpans(row)
	if (marks.length === 0) return spans
	const out: StyledSpan[] = []
	let cell = 0
	for (const span of spans) {
		let run = ''
		let runStyle: Mark['style'] | undefined
		let started = false
		const flush = () => {
			if (run.length > 0)
				out.push(runStyle ? { ...span, text: run, ...runStyle } : { ...span, text: run })
			run = ''
		}
		for (const c of cellsOf(span.text)) {
			const at = cell
			cell += c.width
			let style: Mark['style'] | undefined
			for (const mark of marks) if (at >= mark.from && at < mark.to) style = mark.style
			if (started && style !== runStyle) flush()
			started = true
			runStyle = style
			run += c.text
		}
		flush()
	}
	return out
}
