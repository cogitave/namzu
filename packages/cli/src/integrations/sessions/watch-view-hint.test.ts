import { describe, expect, it } from 'vitest'

import type { TranscriptMessage } from '../../tui/types.js'
import { rowLines } from './watch-view.js'

const row = (content: string, meta?: string): TranscriptMessage => ({
	id: 'r',
	role: 'tool',
	content,
	glyph: '●',
	...(meta !== undefined ? { meta } : {}),
})

const HINT = '(ctrl+o to expand)'
const CONTENT = 'Made 1 commit, ran 1 push, ran 2 commands'

describe('the hint at the end of a watched row', () => {
	it('follows the text after one space, as on the screen', () => {
		expect(rowLines(row(CONTENT, HINT))).toEqual([`● ${CONTENT} ${HINT}`])
	})

	it('leaves another note two spaces after the text', () => {
		expect(rowLines(row(CONTENT, '2s'))).toEqual([`● ${CONTENT}  2s`])
	})

	it('does not move when it fits the terminal', () => {
		expect(rowLines(row(CONTENT, HINT), { columns: 80 })).toEqual([`● ${CONTENT} ${HINT}`])
	})

	it('is never cut across two rows of a narrow terminal', () => {
		for (let columns = 20; columns <= 200; columns++) {
			const lines = rowLines(row(CONTENT, HINT), { columns })
			const wrapped = lines.flatMap((line) => {
				const out: string[] = []
				for (let at = 0; at < Math.max(1, line.length); at += columns) {
					out.push(line.slice(at, at + columns))
				}
				return out
			})
			const text = wrapped.join('\n')
			const whole = text.includes(HINT) || text.includes('(ctrl+o)')
			expect(whole || !text.includes('expand'), `${columns}: ${text}`).toBe(true)
			expect(text.includes('to\nexpand'), `${columns}`).toBe(false)
		}
	})

	it('goes whole onto its own row, under the text', () => {
		expect(rowLines(row(CONTENT, HINT), { columns: 50 })).toEqual([`● ${CONTENT}`, `  ${HINT}`])
	})
})
