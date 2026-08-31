/**
 * A collapsed tool body is measured, and the collapse rule has one owner.
 *
 * Two claims, and they are the same claim from opposite ends.
 *
 * The redrawable tail is bounded by estimated terminal height. Counting each
 * row's `content` and nothing else makes a six-line collapsed tool body look
 * like one row and can grow the live region into Ink's whole-history repaint
 * path. `/expand` makes that acute: it produces a row whose whole substance is
 * its body.
 *
 * And the count has to come from the renderer, because the renderer is the only
 * thing that knows how much of a body prints. A copy of `COLLAPSE_LINES` kept
 * on the measuring side would be correct on the day it was written and silently
 * wrong the first time the collapse changed — with no failure, because a low
 * estimate does not throw.
 */

import { describe, expect, it } from 'vitest'

import { renderedDetailLines } from '../Transcript.js'
import { estimateRenderedLines, transcriptLines } from '../live-window.js'
import type { TranscriptMessage } from '../types.js'

const body = (n: number) => Array.from({ length: n }, (_, i) => `line-${i + 1}`)

function row(over: Partial<TranscriptMessage> = {}): TranscriptMessage {
	return { id: 'm1', role: 'tool', content: 'Bash(ls)', ...over }
}

describe('renderedDetailLines', () => {
	it('is empty for a row with no body, so an ordinary message costs one row', () => {
		expect(renderedDetailLines(row())).toEqual([])
		expect(renderedDetailLines(row({ detail: [] }))).toEqual([])
	})

	it('counts the hint row, because the hint occupies a row too', () => {
		// Twelve lines collapse to six plus the hint: seven, not six. Off by one
		// in the low direction is still the low direction.
		const lines = renderedDetailLines(row({ detail: body(12) }))
		expect(lines).toHaveLength(7)
		expect(lines[6]).toContain('+6 lines')
	})

	it('gives the hint the text it really prints, command included', () => {
		// `… +6 lines · /expand 3` is eleven columns longer than `… +6 lines`, and
		// on a narrow terminal those eleven columns are a second rendered row that
		// the estimate would not know about.
		const lines = renderedDetailLines(row({ detail: body(12), detailRef: 3 }))
		expect(lines[6]).toContain('/expand 3')
	})

	it('measures a body against the width it has, not the width of the terminal', () => {
		// The block renders inside a one-column pad plus the two-column `▏` rule,
		// so three columns are gone before any text. Measuring against the full
		// width says a 78-character line fits on an 80-column terminal; it does
		// not, and the missed wrap is a row the estimate never counted.
		const wide = 'x'.repeat(78)
		const measured = estimateRenderedLines(renderedDetailLines(row({ detail: [wide] })), 80)
		expect(measured).toBe(2)
	})

	it('counts every line of a body that fits, with no hint', () => {
		// Nothing is hidden, so nothing advertises hiding it.
		const lines = renderedDetailLines(row({ detail: body(4) }))
		expect(lines).toHaveLength(4)
		expect(lines[0]).toContain('line-1')
	})

	it('counts the whole body of an expanded row', () => {
		// The row `/expand` pushes. This is the case that would be measured as a
		// single line by anything reading `content` alone.
		expect(renderedDetailLines(row({ detail: body(200), detailExpanded: true }))).toHaveLength(200)
	})
})

describe('what the live-window estimator is given', () => {
	it('includes the body under a tool call, not just the line above it', () => {
		const lines = transcriptLines([row({ detail: body(12) })])
		// The call line plus six shown plus the hint.
		expect(lines).toHaveLength(8)
		expect(lines[0]).toContain('Bash(ls)')
	})

	it('counts the blank row between entries', () => {
		// `MessageRow` puts one above every entry but the first and the `⎿`
		// results. Forty entries is forty rows — a whole viewport on most
		// terminals, silently absent from the estimate.
		const two = transcriptLines([row({ id: 'a' }), row({ id: 'b' })])
		expect(two).toHaveLength(3)
		expect(two[1]).toBe('')
	})

	it('does not count a gap before a result row, which hugs its call', () => {
		const hugging = transcriptLines([row({ id: 'a' }), row({ id: 'b', glyph: '⎿' })])
		expect(hugging).toHaveLength(2)
	})

	it('measures an expanded row as the many rows it is', () => {
		const expanded = row({
			content: 'Bash(ls) — in full (200 lines)',
			detail: body(200),
			detailExpanded: true,
		})
		const measured = estimateRenderedLines(transcriptLines([expanded]), 80)
		expect(measured).toBeGreaterThan(200)
	})

	it('leaves out the row still streaming, which is not in the static log yet', () => {
		// Pending content is already rendered below the finalized live window.
		expect(transcriptLines([row({ pending: true, detail: body(12) })])).toEqual([])
	})
})
