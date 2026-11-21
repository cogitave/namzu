import { expect, it } from 'vitest'

import { plainDiffRows } from '../diff-view.js'
import { messageScrollRows, scrollTextWidth } from '../transcript-scroll.js'
import type { TranscriptMessage } from '../types.js'

const lines = ['import x from "x"', '', '    indented()', '  two()']
const info = {
	mode: 'hunks',
	hunks: [
		{
			oldStart: 1,
			oldLines: 1,
			newStart: 1,
			newLines: 4,
			lines: ['-old', ...lines.map((l) => `+${l}`)],
		},
	],
	added: 4,
	removed: 1,
} as const

const message: TranscriptMessage = {
	id: 'w1',
	role: 'tool',
	glyph: '⎿',
	content: 'Wrote 4 lines to a.ts',
	detail: plainDiffRows(info),
	diff: info,
}

it('paints a written file as the transcript does: no estimate text, indentation and fill kept', () => {
	const { rows } = messageScrollRows(message, true, scrollTextWidth(80))
	const body = rows.slice(1)
	expect(body.length).toBeGreaterThanOrEqual(4)
	for (const row of body) expect(row.text.endsWith('..')).toBe(false)
	const indented = body.find((row) => row.text.includes('indented()'))
	expect(indented?.text).toMatch(/ {4}indented\(\)/)
	expect(indented?.spans?.some((span) => span.background !== undefined)).toBe(true)
})

it('keeps the fold notice as the hint row', () => {
	const many = Array.from({ length: 30 }, (_, i) => `+line ${i}`)
	const big = {
		mode: 'file',
		hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 30, lines: many }],
		preview: 10,
		added: 30,
	} as const
	const { rows } = messageScrollRows(
		{ ...message, diff: big, detail: plainDiffRows(big), detailRef: 1 },
		true,
		78,
	)
	expect(rows.some((row) => row.text.includes('line 9'))).toBe(true)
	expect(rows.some((row) => row.text.includes('line 10'))).toBe(false)
	expect(rows.filter((row) => row.text.includes('..')).length).toBe(0)
})
