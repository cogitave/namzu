/**
 * A reply laid out as it grows is the reply laid out from its text.
 *
 * The stream keeps what is decided of a reply from one piece to the next
 * (`reply-rows.ts`). These tests hold that to the one thing it may not change:
 * the rows. A corpus is written in pieces of several sizes, and at every piece
 * the rows kept by the stream are compared with the rows the whole text gives.
 * Work is counted in characters handed to the scanner and the parser, and in
 * rows kept, never in time.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

const work = { scanned: 0, parsed: 0 }
vi.mock('../markdownParser.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('../markdownParser.js')>()
	return {
		...real,
		scanBlockRanges: (src: string, startsAs?: 'text') => {
			work.scanned += src.length
			return real.scanBlockRanges(src, startsAs)
		},
		parseMarkdown: (src: string) => {
			work.parsed += src.length
			return real.parseMarkdown(src)
		},
	}
})

import { resetCodeHighlightForTests, whenGrammarsSettle } from '../code-highlight.js'
import type { TranscriptMessage } from '../types.js'
import { type StreamedReply, fullscreenMessageRows } from './layout.js'
import { keptLineStats } from './markdown-rows.js'

const CORPUS: Record<string, string> = {
	prose: `# Heading

A paragraph with **bold**, *emphasis* and \`code\` and a [link](https://example.com/x) that wraps over a few rows of text.

- one
- two with more words than fit in a single row of the window, so it wraps
  - nested

1. first
2. second

> a quote
> over two lines

---

Closing words.`,
	table: `Before.

| Name | Kind |
|------|------|
| alpha | file |
| beta | dir |

After the table.`,
	code: `Here it is.

\`\`\`ts
export function add(a: number, b: number): number {
  const sum = a + b // the total
  return sum
}

const text = \`a
  b\`
\`\`\`

Then python:

\`\`\`python
def f(x):
    """doc
    string"""
    return x  # done
\`\`\`

And a tilde fence with no language:

~~~
plain text here
~~~

Last, an unknown one:

\`\`\`klingon
nuqneH 123
\`\`\`

The end.`,
	open: 'Start.\n\n```ts\nconst a = 1\nconst b = 2\n',
	empty: 'Start.\n\n```ts\n```\n\nNext.\n\n```\n\n```\n',
	indented: '- item\n\n  ```ts\n  const a = 1\n  const b = 2\n  ```\n\n- next item\n\ntext',
	long: `\`\`\`ts\n${Array.from({ length: 60 }, (_, i) => `const value${i} = compute(${i}, "${'x'.repeat(i * 3)}")`).join('\n')}\n\`\`\`\nDone.`,
	comment: `\`\`\`ts\n/* a long comment\n${'still going on and on\n'.repeat(40)}*/\nconst x = 1\n\`\`\`\n`,
	unclosedTable: 'Text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3',
	rules: 'One\n\n***\n\nTwo\n\n---\n\n- - -\n\nThree',
	blob: `\`\`\`ts\nconst a = 1\nconst b = "${'q'.repeat(500)}"\nconst c = 3\nconst d = 4\n\`\`\``,
	ends: '```ts\nconst a = 1\n```',
	endsOpen: '```ts\nconst a = 1',
	bareFence: '```',
	opener: 'Some words\n```ts',
}

function rowsOf(
	content: string,
	pending: boolean,
	width: number,
	streams?: Map<string, StreamedReply>,
): string {
	const message: TranscriptMessage = { id: 'a', role: 'assistant', content, pending }
	const block = fullscreenMessageRows(message, true, width, undefined, streams)
	return JSON.stringify(block.rows)
}

beforeAll(async () => {
	resetCodeHighlightForTests()
	await whenGrammarsSettle(['ts', 'python', 'klingon'])
})

describe('a reply laid out as it grows', () => {
	for (const [name, text] of Object.entries(CORPUS)) {
		for (const width of [30, 76]) {
			it(`is the reply laid out from its text: ${name}, ${width} columns`, () => {
				const streams = new Map<string, StreamedReply>()
				// Pieces of one, then a few, then a line or more, as a model writes them.
				for (const piece of [1, 7, 50]) {
					streams.clear()
					for (let at = piece; ; at += piece) {
						const content = text.slice(0, Math.min(at, text.length))
						const done = at >= text.length
						expect(rowsOf(content, !done, width, streams), `${piece}@${at}`).toBe(
							rowsOf(content, !done, width),
						)
						if (done) break
					}
				}
			})
		}
	}

	it('starts again when the text is not what it was', () => {
		const streams = new Map<string, StreamedReply>()
		rowsOf('```ts\nconst a = 1\nconst b = 2\n', true, 76, streams)
		expect(rowsOf('Another reply\n\ntext', true, 76, streams)).toBe(
			rowsOf('Another reply\n\ntext', true, 76),
		)
	})

	it('lays out from the whole text a reply that has a control character in it', () => {
		const streams = new Map<string, StreamedReply>()
		const text = 'one\r\n\r\n```ts\r\nconst a = 1\r\n```\r\n\r\ntwo\u0007'
		for (let at = 1; at <= text.length; at += 3) {
			const content = text.slice(0, at)
			expect(rowsOf(content, at < text.length, 76, streams)).toBe(
				rowsOf(content, at < text.length, 76),
			)
		}
	})
})

/** A reply of `kb` kilobytes: code under a fence, or prose and lists. */
function big(kind: 'code' | 'prose', kb: number): string {
	let out = ''
	for (let i = 0; out.length < kb * 1024; i++) {
		if (kind === 'code')
			out += `const value${i}: number = compute(${i}, "text ${i}") // line ${i}\n`
		else
			out += `Paragraph ${i} with **bold ${i}**, *emphasis*, \`code${i}\` and a [link](https://example.com/${i}) that wraps over rows.\n\n${i % 10 === 5 ? `- item a ${i}\n- item b ${i}\n\n` : ''}`
	}
	return kind === 'code' ? `Here it is.\n\n\`\`\`ts\n${out}\`\`\`\nDone.` : `${out}Done.`
}

describe('the work a piece costs', () => {
	for (const kind of ['code', 'prose'] as const) {
		it(`follows what the piece brought, not the reply so far: ${kind}`, () => {
			const text = big(kind, 150)
			const streams = new Map<string, StreamedReply>()
			work.scanned = 0
			work.parsed = 0
			let last = ''
			const piece = 500
			let pieces = 0
			for (let at = piece; ; at += piece) {
				const done = at >= text.length
				const content = text.slice(0, Math.min(at, text.length))
				const message: TranscriptMessage = { id: 'a', role: 'assistant', content, pending: !done }
				last = String(fullscreenMessageRows(message, true, 76, undefined, streams).rows.length)
				pieces += 1
				if (done) break
			}
			expect(Number(last)).toBeGreaterThan(1000)
			// Every character is scanned and parsed a few times over, not once per piece after it.
			expect(work.scanned).toBeLessThan(text.length * 6)
			expect(work.parsed).toBeLessThan(text.length * 6)
			expect(pieces).toBeGreaterThan(300)
		})
	}

	it('keeps each row of a long code block once', () => {
		const text = big('code', 400)
		const streams = new Map<string, StreamedReply>()
		const before = keptLineStats()
		let rows = 0
		for (let at = 2000; ; at += 2000) {
			const done = at >= text.length
			const message: TranscriptMessage = {
				id: 'a',
				role: 'assistant',
				content: text.slice(0, Math.min(at, text.length)),
				pending: !done,
			}
			rows = fullscreenMessageRows(message, true, 76, undefined, streams).rows.length
			if (done) break
		}
		expect(rows).toBeGreaterThan(5000)
		// The rows the window shows are the only copy of the lines past the colour limit: the
		// line cache holds the colour window of the block, and nothing near the reply's length.
		const after = keptLineStats()
		expect(after.chars - before.chars).toBeLessThan(400_000)
		expect(after.lines).toBeLessThan(rows / 2)
	})
})
