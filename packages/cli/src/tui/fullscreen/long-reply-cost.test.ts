/**
 * What a reply costs to lay out again as it grows.
 *
 * A streamed reply is laid out at every piece. The work must follow what
 * changed, not the length of the reply: a long code block earlier in it, or a
 * single line of tens of thousands of characters, is not wrapped again for each
 * piece after it. Counted in characters handed to the wrapper and in rows kept,
 * never in time.
 */

import { describe, expect, it, vi } from 'vitest'

const wrapped = { chars: 0 }
vi.mock('../terminal-choice-text.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('../terminal-choice-text.js')>()
	return {
		...real,
		wrapChoiceText: (source: string, columns: number) => {
			wrapped.chars += source.length
			return real.wrapChoiceText(source, columns)
		},
	}
})

import { fullscreenMessageRows } from './layout.js'
import { markdownRows } from './markdown-rows.js'

const BIG = `\`\`\`ts\n${'"'.repeat(50_000)}\n\`\`\`\n\n`

describe('a reply that grows', () => {
	it('keeps the rows of the blocks before the one that is changing', () => {
		const first = markdownRows(`${BIG}Closing`, 76, '#fff')
		const next = markdownRows(`${BIG}Closing words`, 76, '#fff')
		// The code block's rows are the very ones made before.
		expect(next[0]).toBe(first[0])
		expect(next[600]).toBe(first[600])
		expect(next.at(-1)?.text).toBe('Closing words')
	})

	it('does not wrap the whole reply in plain form to draw it as Markdown', () => {
		wrapped.chars = 0
		const rows = fullscreenMessageRows(
			{ id: 'a', role: 'assistant', content: `${BIG}${BIG}Closing words` },
			true,
			76,
		)
		expect(rows.rows.at(-1)?.text).toBe('Closing words')
		expect(wrapped.chars).toBeLessThan(1_000)
	})
})
