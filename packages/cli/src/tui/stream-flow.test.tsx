/**
 * A reply drawn as it is written is, once finished, the reply drawn whole.
 *
 * Each reply of a corpus is fed to the printing logic one character at a time,
 * so every position the stream could stop at is a position tested. At each
 * one: what has been printed must be the first rows of the whole reply drawn the
 * old way (a printed row is never different from the same row of the finished
 * reply), and what is drawn of the tail must read as the start of the finished
 * text (no raw marker, no half word, is shown to be replaced). At the end, the
 * parts and the rest are the whole reply, row for row.
 */

import { Box, renderToString } from 'ink'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ContentWidth } from './Markdown.js'
import { MessageRow, ReplyPieceRow } from './Transcript.js'
import { markdownRows } from './fullscreen/markdown-rows.js'
import {
	type FlowContext,
	PACE_MS,
	appendReply,
	freezeMore,
	paceDecision,
	printedPieces,
	tailPiece,
	tailStateOf,
	tailView,
} from './stream-flow.js'
import type { PrintedChunk, TranscriptMessage } from './types.js'

let WIDTH = 38
let CTX: FlowContext = { freeze: true, width: WIDTH, rows: 24, hyperlinks: false }

/** The corpus is held to the same rule at a narrow width and at a wide one. */
function at(width: number, rows: number): void {
	WIDTH = width
	CTX = { freeze: true, width, rows, hyperlinks: false }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes to read the text
const ANSI = /\u001b\[[0-9;]*m/gu

function rows(node: React.ReactNode): string[] {
	return renderToString(
		<ContentWidth.Provider value={WIDTH}>
			<Box width={WIDTH + 2} flexDirection="column">
				{node}
			</Box>
		</ContentWidth.Provider>,
		{ columns: WIDTH + 2 },
	)
		.replace(ANSI, '')
		.split('\n')
		.map((r) => r.replace(/ +$/u, ''))
}

const message = (content: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
	id: 'm',
	role: 'assistant',
	content,
	...extra,
})

/** The whole reply, drawn the old way: one message, one render. */
function whole(reply: string): string[] {
	return rows(<MessageRow message={message(reply)} prev={undefined} hyperlinks={false} />)
}

function pieceRows(
	msg: TranscriptMessage,
	piece: ReturnType<typeof printedPieces>[number],
): string[] {
	return rows(<ReplyPieceRow message={msg} prev={undefined} piece={piece} hyperlinks={false} />)
}

const BOX = /^[─│┌┐└┘├┤┬┴┼]+$/u
function words(text: string[]): string[] {
	return text
		.join(' ')
		.split(/\s+/u)
		.filter((w) => w.length > 0 && !BOX.test(w))
}

const LONG_PARAGRAPH = Array.from(
	{ length: 22 },
	(_, i) =>
		`Sentence number ${i} says that the kernel keeps \`state\` and **names** what it did, see [the page](https://example.com/p${i}).`,
).join(' ')

const LONG_CODE = [
	'```ts',
	...Array.from({ length: 36 }, (_, i) => `const value${i} = compute(${i}) // line ${i}`),
	'',
	'const tail = 1',
	'```',
	'after the code',
].join('\n')

const CORPUS: Record<string, string> = {
	paragraphs:
		'First paragraph with some words in it.\n\nSecond paragraph here, a little longer than the first one.\n\nThird.',
	finalNewline: 'One paragraph.\n\nTwo paragraph.\n',
	noFinalNewline: 'Just a sentence that stops without a newline',
	nestedLists: '- one\n  - nested a\n  - nested b\n- two\n\n1. first\n2. second\n3) third\n\nDone.',
	tableNarrow: 'Intro line.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.',
	tableAligned: '| name | n |\n|:--|--:|\n| x | 1 |\n| yy | 22 |\n',
	tableWide:
		'| Name | Description | Notes |\n|---|---|---|\n| alpha | A fairly long description that has to wrap inside its column | note one |\n| beta | Another description of some length again | note two |\n\nEnd.',
	fenceLang: 'Run:\n\n```sh\nnpm install\n\nnpm test\n```\n\nThen done.',
	fenceNoLang: '```\nplain\ncode here\n```\ntext right after',
	headings: '# Title\n\n## Subtitle here\n\nBody text.\n### Third\nmore body',
	quotes: '> a quoted line that goes on\n> and a second one\n\n> > nested\n\nplain',
	rules: 'above\n\n---\n\nbelow\n\n***\n\nend',
	emphasis:
		'This is **bold text** and *italic text* and `inline code` and [a link](https://example.com/x) and __under__ end.',
	literalStar: 'We compute 2 * 3 = 6 and write snake_case names, then 4 * 5 = 20 here.',
	dashesAtEnd: 'Some text\n---',
	dashesAfterBlank: 'Some text\n\n---',
	markerAtEnd: 'Intro\n\n-',
	turkish:
		'Merhaba dünya, şöyle güzel bir çağrı: ıspanak, öğle yemeği ve çocuklar için süt.\n\n- şeker\n- çay',
	wide: '你好世界，这是一个很长的句子，需要在窄屏幕上换行显示出来，看看会怎样。\n\nうれしい 日本語 の 文章 です。',
	longParagraph: `${LONG_PARAGRAPH}\n\nAfter the long one.`,
	longCode: LONG_CODE,
	mixed: [
		'# Plan',
		'',
		'Intro with **bold**.',
		'',
		'- item one',
		'- item two with `code`',
		'',
		'| k | v |',
		'|---|---|',
		'| a | 1 |',
		'',
		'```',
		'code',
		'```',
		'',
		'> quote',
		'',
		'End.',
	].join('\n'),
}

function run(reply: string, layoutChanges = false): void {
	const full = whole(reply)
	const fullWords = words(markdownRows(reply, WIDTH, 'x').map((r) => r.text))
	let printed: readonly PrintedChunk[] = []
	let printedRowsSoFar: string[] = []
	let msg = message('', { pending: true })
	for (let p = 1; p <= reply.length; p++) {
		const content = reply.slice(0, p)
		const next = freezeMore(content, printed, CTX)
		if (next) {
			const fresh = next.slice(printed.length)
			printed = next
			msg = message(content, { pending: true, printed })
			const pieces = printedPieces(printed)
			for (let k = 0; k < fresh.length; k++) {
				const idx = printed.length - fresh.length + k
				printedRowsSoFar = printedRowsSoFar.concat(pieceRows(msg, pieces[idx] as never))
			}
			// A printed row is the same row of the finished reply.
			expect(printedRowsSoFar, `at ${p}`).toEqual(full.slice(0, printedRowsSoFar.length))
		}
		// What is shown now reads as the start of the finished text.
		const visible = chunksVisible(content, printed, p === reply.length)
		const shown = words(markdownRows(visible, WIDTH, 'x').map((r) => r.text))
		// A table too wide for a box is drawn as records, and whether it is
		// is known only once its widest row has arrived: it is the one construct
		// whose look can change as it grows.
		if (!layoutChanges) expect(shown, `words at ${p}`).toEqual(fullWords.slice(0, shown.length))
	}
	// Finished: the parts and the rest are the whole reply.
	const done = message(reply, { printed })
	const pieces = printedPieces(printed)
	const rest = tailPiece(done)
	const all = [...pieces, ...(rest ? [rest] : [])].flatMap((piece) => pieceRows(done, piece))
	expect(all).toEqual(full)
}

/** Printed text plus what of the tail is drawn: a prefix of the reply. */
function chunksVisible(
	content: string,
	printed: readonly PrintedChunk[],
	finished: boolean,
): string {
	const base = printed.map((c) => c.text).join('')
	const tail = content.slice(base.length)
	return base + (finished ? tail : tailView(tail, tailStateOf(printed)))
}

describe.each([
	[38, 24],
	[96, 40],
])('a reply drawn as it is written, %i cells wide', (width, height) => {
	beforeEach(() => at(width, height))
	afterEach(() => at(38, 24))
	for (const [name, reply] of Object.entries(CORPUS)) {
		it(`${name}: every position agrees with the whole reply`, () => {
			run(reply, name === 'tableWide')
		}, 120_000)
	}
})

describe('a reply drawn as it is written', () => {
	it('prints parts of a long paragraph and of a long code block while they are written', () => {
		for (const reply of [LONG_PARAGRAPH, LONG_CODE]) {
			let printed: readonly PrintedChunk[] = []
			let most = 0
			for (let p = 1; p <= reply.length; p++) {
				printed = freezeMore(reply.slice(0, p), printed, CTX) ?? printed
				const tail = tailView(
					reply.slice(printed.map((c) => c.text).join('').length, p),
					tailStateOf(printed),
				)
				most = Math.max(most, markdownRows(tail, WIDTH, 'x').length)
			}
			expect(printed.length).toBeGreaterThan(0)
			// The live part never outgrows half the window by much.
			expect(most).toBeLessThanOrEqual(12 + 4)
		}
	})

	it('holds a table to its complete rows and prints it once complete', () => {
		const t = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 |'
		const none = tailView(t.slice(0, 9), { join: 'block', lead: null })
		expect(none).toBe('')
		const partialSep = tailView('| a | b |\n| -', { join: 'block', lead: null })
		expect(partialSep).toBe('')
		const header = tailView('| a | b |\n| - | - |\n', { join: 'block', lead: null })
		expect(header).toContain('| a | b |')
		const rowsShown = tailView(t, { join: 'block', lead: null })
		expect(rowsShown).toBe('| a | b |\n| - | - |\n| 1 | 2 |')
		expect(freezeMore(t, [], CTX)).toBeUndefined()
		expect(freezeMore(`${t} | 4 |\n\nx`, [], CTX)?.[0]?.last).toBe('table')
	})

	it('holds what could still become something else', () => {
		const v = (s: string) => tailView(s, { join: 'block', lead: null })
		expect(v('word one tw')).toBe('word one')
		expect(v('some **bold te')).toBe('some')
		expect(v('see [a li')).toBe('see')
		expect(v('see [a link](http://x')).toBe('see')
		expect(v('a `co')).toBe('a')
		expect(v('2 * 3 and more')).toBe('2')
		expect(v('text\n---')).toBe('text')
		expect(v('text\n-')).toBe('text')
		expect(v('text\n\n#')).toBe('text')
		expect(v('text\n\n12.')).toBe('text')
		expect(v('```')).toBe('')
		expect(v('```js\nconst a = 1\nconst b')).toBe('```js\nconst a = 1')
		expect(v('- ')).toBe('')
		expect(v('- item wi')).toBe('- item')
		expect(v('- item with more')).toBe('- item with')
		expect(v('# Head')).toBe('')
		expect(v('# Head line')).toBe('# Head')
		expect(v('first line\n')).toBe('first line')
	})
})

describe('the pace of the tail', () => {
	it('draws at once, then at most about twelve times a second, one timer, nothing when nothing arrives', () => {
		// A fake clock: 1000 deltas, one every millisecond, for one second.
		let now = 1_000
		let lastFlush: number | undefined
		let timerAt: number | undefined
		let flushes = 0
		let timers = 0
		const flush = () => {
			flushes++
			lastFlush = now
			timerAt = undefined
		}
		for (let i = 0; i < 1000; i++) {
			now += 1
			if (timerAt !== undefined && now >= timerAt) flush()
			const d = paceDecision(now, lastFlush, timerAt !== undefined)
			if (d.action === 'flush') flush()
			else if (d.action === 'arm') {
				timers++
				timerAt = now + d.delay
			}
		}
		if (timerAt !== undefined) {
			now = timerAt
			flush()
		}
		expect(flushes).toBeLessThanOrEqual(Math.ceil(1000 / PACE_MS) + 1)
		expect(flushes).toBeGreaterThanOrEqual(10)
		expect(timers).toBeLessThanOrEqual(flushes)
		// Nothing arrived: nothing is decided, so nothing is armed.
		expect(paceDecision(now + 5_000, lastFlush, false).action).toBe('flush')
	})

	it('the first words are drawn with no wait', () => {
		expect(paceDecision(5, undefined, false)).toEqual({ action: 'flush' })
	})
})

describe('appendReply', () => {
	it('prints only for a pending plain reply when asked to', () => {
		const m = message('', { pending: true })
		const text = 'Done.\n\nNext paragraph'
		expect(appendReply(m, text, CTX).printed?.length).toBe(1)
		expect(appendReply(m, text, { ...CTX, freeze: false }).printed).toBeUndefined()
		expect(appendReply(m, text, undefined).printed).toBeUndefined()
		expect(appendReply({ ...m, meta: 'x' }, text, CTX).printed).toBeUndefined()
	})
})
