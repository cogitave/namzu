/**
 * A collapsed tool body is measured, and the collapse rule has one owner.
 *
 * The live-window estimate must count both preview fragments and the omission
 * row, including wrapping. Expanded bodies are measured in full so a large
 * result enters scrollback instead of forcing whole-history redraws.
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
		// Three opening lines, the omission row, and three closing lines.
		const lines = renderedDetailLines(row({ detail: body(12) }))
		expect(lines).toEqual([
			'   line-1',
			'   line-2',
			'   line-3',
			'   … 6 lines omitted',
			'   line-10',
			'   line-11',
			'   line-12',
		])
	})

	it('gives the hint the text it really prints, command included', () => {
		// The complete hint can wrap on a narrow terminal, so measurement must
		// include both the omission count and the available action.
		const lines = renderedDetailLines(row({ detail: body(12), detailRef: 3 }))
		expect(lines[3]).toBe('   … 6 lines omitted · ctrl+o')
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
		const lines = renderedDetailLines(row({ detail: body(6), detailRef: 1 }))
		expect(lines).toEqual(body(6).map((line) => `   ${line}`))
	})

	it('omits exactly the middle line when a body first exceeds the preview', () => {
		const lines = renderedDetailLines(row({ detail: body(7), detailRef: 1 }))
		expect(lines).toEqual([
			'   line-1',
			'   line-2',
			'   line-3',
			'   … 1 line omitted · ctrl+o',
			'   line-5',
			'   line-6',
			'   line-7',
		])
	})

	it('counts the whole body of an expanded row', () => {
		// Reading only the summary would count a single line for this full body.
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
