/**
 * What a long reply of many blocks costs to lay out again as it grows.
 *
 * Each block is wrapped once, however many blocks come after it. The reply being written keeps
 * the rows of the blocks that cannot change any more (`reply-rows.ts`); without that every block
 * was wrapped at every piece and a reply of 200 KB of prose cost the square of its length.
 * Counted in characters handed to the wrapper, never in time.
 */

import { describe, expect, it, vi } from 'vitest'

const wrapped = { chars: 0, codeLines: 0 }
vi.mock('../markdown-wrap.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('../markdown-wrap.js')>()
	return {
		...real,
		wrapSpans: (spans: Parameters<typeof real.wrapSpans>[0], width: number) => {
			for (const s of spans) wrapped.chars += s.text.length
			return real.wrapSpans(spans, width)
		},
	}
})

vi.mock('./code-wrap.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('./code-wrap.js')>()
	return {
		...real,
		wrapCodeLine: (line: string, width: number) => {
			wrapped.codeLines += 1
			return real.wrapCodeLine(line, width)
		},
	}
})

import type { TranscriptMessage } from '../types.js'
import { type StreamedReply, fullscreenMessageRows } from './layout.js'

/** The rows of a reply being written, the way the window asks for them: one stream per reply. */
function growing(streams: Map<string, StreamedReply>) {
	return (content: string, width: number) => {
		const message: TranscriptMessage = { id: 'a', role: 'assistant', content, pending: true }
		return fullscreenMessageRows(message, true, width, undefined, streams).rows
	}
}

const paragraph = (i: number) =>
	`Paragraph ${i} of a long reply with **bold ${i}** and \`code ${i}\` and enough words to wrap over several rows of the window.`

describe('a long reply that grows', () => {
	it('wraps each block once, not once per piece', () => {
		const COUNT = 400 // well past the 48 blocks that were once kept
		let text = ''
		const rowsOf = growing(new Map())
		let last: ReturnType<typeof rowsOf> = []
		for (let i = 0; i < COUNT; i++) {
			text += `${paragraph(i)}\n\n`
			last = rowsOf(text, 60)
		}
		expect(last.length).toBeGreaterThan(COUNT)
		// Each block once, and the one still growing at each piece: about twice the text.
		expect(wrapped.chars).toBeLessThan(text.length * 3)
	})

	it('cuts each line of a growing code block once, not once per piece', () => {
		wrapped.codeLines = 0
		const LINES = 600
		let body = ''
		const rowsOf = growing(new Map())
		let rows: ReturnType<typeof rowsOf> = []
		for (let i = 0; i < LINES; i++) {
			body += `const value${i}: number = compute(${i}, "text ${i}") // line ${i}\n`
			rows = rowsOf(`\`\`\`ts\n${body}`, 60)
		}
		expect(rows.length).toBeGreaterThanOrEqual(LINES)
		// A line is cut when it first arrives; the line still being written may be cut a few
		// times more. Cut again at every piece it would be about LINES * LINES / 2 times.
		expect(wrapped.codeLines).toBeLessThan(LINES * 3)
	})
})
