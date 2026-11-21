import { expect, it } from 'vitest'

import type { ContextView } from '../context-grid.js'
import { messageScrollRows, scrollTextWidth } from '../transcript-scroll.js'
import type { TranscriptMessage } from '../types.js'

const cell = (glyph: string, dim = false) => ({ glyph, color: '#00ff00', dim })
const view: ContextView = {
	model: 'vendor/model-a',
	cells: [
		[cell('⛁'), cell('⛁'), cell('⛶', true)],
		[cell('⛶', true), cell('⛶', true), cell('⛝')],
	],
	usage: '58.2k/1m tokens (6%)',
	legend: [
		{
			glyph: '⛁',
			color: '#00ff00',
			name: 'System prompt',
			value: '4.2k tokens (0.4%)',
			dimGlyph: false,
			dimName: false,
		},
		{
			glyph: '⛶',
			color: '#888888',
			name: 'Free space',
			value: '908.8k (90.9%)',
			dimGlyph: true,
			dimName: true,
		},
	],
	sections: [
		{
			title: 'Skills',
			hint: '/skills',
			groups: [{ heading: 'Built-in', items: [{ label: 'document', value: '~40' }] }],
		},
	],
	suggestions: [],
	notes: ['Nothing summarised yet.'],
	text: 'Context usage\nvendor/model-a\n58.2k/1m tokens (6%)\nEstimated usage by category\nSystem prompt: 4.2k tokens (0.4%)',
}

const message: TranscriptMessage = {
	id: 'c1',
	role: 'system',
	content: view.text,
	contextView: view,
}

it('draws /context as the grid with its legend beside it, not as its plain-text copy', () => {
	const width = scrollTextWidth(100)
	const { rows } = messageScrollRows(message, true, width)
	expect(rows[0]?.text.trim()).toBe('Context usage')
	// The first grid row carries the model name beside the cells.
	expect(rows[1]?.text).toContain('⛁ ⛁ ⛶')
	expect(rows[1]?.text).toContain('vendor/model-a')
	// Rows past the grid keep the legend under the right column, indented by the grid's width.
	const legend = rows.find((row) => row.text.includes('System prompt: 4.2k tokens'))
	expect(legend?.text.startsWith(' '.repeat(1 + 3 * 2 + 2))).toBe(true)
	expect(rows.some((row) => row.text.includes('└ document: ~40'))).toBe(true)
	expect(rows.some((row) => row.text.includes('Nothing summarised yet.'))).toBe(true)
	for (const row of rows) expect(row.text.length).toBeLessThanOrEqual(width + 2)
	// Coloured cells: a cell's colour, a dim cell in the muted colour.
	expect(rows[1]?.spans?.some((span) => span.text === '⛁ ' && span.color === '#00ff00')).toBe(true)
})

it('cuts a row to the width instead of wrapping it into the next', () => {
	const { rows } = messageScrollRows(message, false, 20)
	for (const row of rows) expect(row.text.length).toBeLessThanOrEqual(22)
})
