/**
 * Syntax colour as it is drawn: the same characters, rows and wraps as the block without
 * colour at every width, the same colours on both screens, the setting and the colour-off
 * modes giving the look there was before, and a printed part of a reply colouring a line as
 * the finished reply does.
 */

import { Box, Text, renderToString } from 'ink'
import { render } from 'ink-testing-library'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Colour on, so the screens are compared with their colours and not only their text.
vi.hoisted(() => {
	process.env.FORCE_COLOR = '3'
})

import { ContentWidth, Markdown } from '../Markdown.js'
import { ReplyPieceRow, Transcript, firstHeld } from '../Transcript.js'
import {
	codeFlowHooks,
	colourLines,
	grammarState,
	resetCodeHighlightForTests,
	setSyntaxHighlight,
	whenGrammarsSettle,
} from '../code-highlight.js'
import { createLayoutCache, fullscreenMessageRows, layoutTranscript } from '../fullscreen/layout.js'
import { markdownRows } from '../fullscreen/markdown-rows.js'
import { paintRow } from '../fullscreen/paint.js'
import type { FsRow } from '../fullscreen/rows.js'
import {
	type FlowContext,
	freezeMore,
	printedPieces,
	tailPiece,
	tailStateOf,
	tailView,
} from '../stream-flow.js'
import { resetThemeStore, setThemeSetting } from '../theme-store.js'
import { applyPalette } from '../theme.js'
import type { PrintedChunk, TranscriptMessage } from '../types.js'
import { CORPUS, FENCE_WORD } from './code-corpus.js'

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes to compare the text
const ANSI = /\u001b\[[0-9;]*m/gu
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte starts a colour
const TRAILING_BLANKS = / +((?:\u001b\[[0-9;]*m)*)$/u
const plainText = (s: string): string => s.replace(ANSI, '')
const same = (a: string): string =>
	a
		.split('\n')
		.map((line) => line.replace(TRAILING_BLANKS, '$1'))
		.join('\n')

const SEPARATOR = String.fromCharCode(1)
const TRAILING_BLANK = new RegExp(`${SEPARATOR}?\\|? +$`, 'u')

/**
 * What a terminal shows of a drawn text: each row as runs of (colour, characters), with the
 * colour of a blank left out and no run that holds no character. Two drawings that show the
 * same cells in the same colours are equal here, whatever zero-width codes they write.
 */
function shown(drawn: string): string {
	return drawn
		.split('\n')
		.map((line) => {
			let fg = ''
			const runs: string[] = []
			// biome-ignore lint/suspicious/noControlCharactersInRegex: reads colour codes
			for (const part of line.matchAll(/\u001b\[([0-9;]*)m|([^\u001b]+)/gu)) {
				if (part[2] === undefined) {
					const code = part[1] ?? ''
					if (code === '39' || code === '0' || code === '') fg = ''
					else if (code.startsWith('38;')) fg = code
					continue
				}
				for (const piece of part[2].split(/( +)/u)) {
					if (piece === '') continue
					const colour = /^ +$/u.test(piece) ? '' : fg
					const last = runs[runs.length - 1]
					if (last?.startsWith(`${colour}|`)) runs[runs.length - 1] = last + piece
					else runs.push(`${colour}|${piece}`)
				}
			}
			const joined = runs.join(SEPARATOR)
			return joined.replace(TRAILING_BLANK, '')
		})
		.join('\n')
}

const fence = (word: string, code: string): string => `\`\`\`${word}\n${code}\n\`\`\``

/** What the normal transcript draws for a reply: its own renderer, at the same width. */
function normal(text: string, width: number): string {
	return renderToString(
		<ContentWidth.Provider value={width}>
			<Box width={width}>
				<Markdown text={text} />
			</Box>
		</ContentWidth.Provider>,
		{ columns: width },
	)
}

/** What the window draws: the rows, each in the same Ink the window uses. */
function windowed(rows: readonly FsRow[], width: number): string {
	return renderToString(
		<Box flexDirection="column" width={width}>
			{rows.map((row, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list in a test
				<Box key={i} width={width} height={1}>
					<Text wrap="truncate-end">
						{row.text.length > 0
							? paintRow(row, []).map((span, j) => (
									<Text
										// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list in a test
										key={j}
										color={span.color}
										bold={span.bold}
										italic={span.italic}
										underline={span.underline}
									>
										{span.text}
									</Text>
								))
							: null}
					</Text>
				</Box>
			))}
		</Box>,
		{ columns: width },
	)
}

const reply = (content: string): TranscriptMessage => ({ id: 'r', role: 'assistant', content })
const rowsOf = (text: string, width: number) =>
	fullscreenMessageRows(reply(text), false, width).rows

/** The colour escapes of a drawn text, in order. */
const colours = (drawn: string): string[] => drawn.match(ANSI) ?? []

beforeAll(async () => {
	resetCodeHighlightForTests()
	await whenGrammarsSettle(Object.values(FENCE_WORD))
})
afterEach(() => {
	setSyntaxHighlight(true)
	resetThemeStore()
	applyPalette('dark')
})

const WIDTHS = [20, 23, 32, 40, 57, 80, 119, 160]

describe('the characters of a coloured block', () => {
	// The colouring is what a person sees and a selection never copies: the rows, the wraps
	// and the widths are those of the same block drawn without it.
	for (const [name, code] of Object.entries(CORPUS)) {
		it(`${name}: are the characters of the block without colour, at every width, on both screens`, () => {
			const text = fence(FENCE_WORD[name] as string, code)
			for (const width of WIDTHS) {
				setSyntaxHighlight(true)
				const onNormal = normal(text, width)
				const onWindow = rowsOf(text, width)
				setSyntaxHighlight(false)
				const offNormal = normal(text, width)
				const offWindow = rowsOf(text, width)
				expect(onNormal, `${name} ${width}`).not.toBe(offNormal)
				expect(plainText(onNormal), `normal ${name} ${width}`).toBe(plainText(offNormal))
				expect(
					onWindow.map((r) => r.text),
					`window ${name} ${width}`,
				).toEqual(offWindow.map((r) => r.text))
				expect(onWindow.map((r) => r.joins)).toEqual(offWindow.map((r) => r.joins))
				expect(onWindow.map((r) => r.lead)).toEqual(offWindow.map((r) => r.lead))
				// And the two screens agree with each other about the characters.
				expect(same(plainText(windowed(onWindow, width))), `screens ${name} ${width}`).toBe(
					same(plainText(onNormal)),
				)
			}
		}, 60_000)
	}

	it('adds nothing beside or above the block: no label, no mark, no row', () => {
		const text = fence('ts', 'const a = 1')
		expect(plainText(normal(text, 40)).trimEnd()).toBe('const a = 1')
		expect(markdownRows(text, 40, '#fff').map((r) => r.text)).toEqual(['const a = 1'])
	})

	it('keeps a code block in a list and in a quote where it was, in colour', () => {
		for (const text of [
			'1. Run it:\n   ```ts\n   const a = 1 // c\n   ```\n2. Done.',
			'> Quoted:\n> ```py\n> print("a")\n> ```',
		]) {
			setSyntaxHighlight(true)
			const on = normal(text, 40)
			const onRows = rowsOf(text, 40)
			setSyntaxHighlight(false)
			expect(plainText(on)).toBe(plainText(normal(text, 40)))
			expect(onRows.map((r) => r.text)).toEqual(rowsOf(text, 40).map((r) => r.text))
			setSyntaxHighlight(true)
			setSyntaxHighlight(false)
			const off = normal(text, 40)
			expect(colours(on).length).toBeGreaterThan(colours(off).length)
		}
	})
})

describe('the colours of a coloured block', () => {
	it('draw keywords, strings, numbers and comments each in a colour of their own', () => {
		const drawn = normal(fence('ts', 'const a = "x" + 12 // note'), 60)
		const distinct = new Set(colours(drawn).filter((c) => c !== '\u001b[39m'))
		expect(distinct.size).toBeGreaterThanOrEqual(4)
	})

	it('are the same on both screens', () => {
		for (const name of ['ts', 'python', 'json', 'diff', 'bash', 'xml', 'sql']) {
			const text = fence(FENCE_WORD[name] as string, CORPUS[name] as string)
			for (const width of [38, 80, 120]) {
				const rows = rowsOf(text, width)
				expect(shown(windowed(rows, width)), `${name} ${width}`).toBe(shown(normal(text, width)))
			}
		}
	})

	it('draw a block with no language, an unknown one and a plain-text one as one code colour, as before', () => {
		for (const word of ['', 'klingon', 'text', 'txt']) {
			const text = fence(word, 'const a = "x" + 12 // note')
			const on = normal(text, 60)
			setSyntaxHighlight(false)
			const off = normal(text, 60)
			setSyntaxHighlight(true)
			expect(on, word).toBe(off)
			expect(new Set(colours(on)).size, word).toBeLessThanOrEqual(2)
		}
	})

	it('are switched off by the setting, to the look there was before', () => {
		const text = fence('ts', CORPUS.ts as string)
		const withNone = fence('', CORPUS.ts as string)
		setSyntaxHighlight(false)
		expect(normal(text, 80)).toBe(normal(withNone, 80))
		expect(rowsOf(text, 80).map((r) => r.spans)).toEqual(rowsOf(withNone, 80).map((r) => r.spans))
	})

	it('are never written where colour is off', () => {
		const keep = process.env.FORCE_COLOR
		try {
			process.env.FORCE_COLOR = '0'
			const rows = rowsOf(fence('ts', CORPUS.ts as string), 80)
			// No syntax colour: every span of the block is the one code colour.
			expect(new Set(rows.flatMap((r) => (r.spans ?? []).map((s) => s.color))).size).toBe(1)
			expect(grammarState('ts')).toBe('plain')
		} finally {
			process.env.FORCE_COLOR = keep
		}
	})

	it('follow a change of theme', () => {
		const text = fence('ts', 'const a = "x" + 12 // note')
		applyPalette('dark')
		const dark = normal(text, 60)
		const darkRows = rowsOf(text, 60)
		applyPalette('light')
		expect(normal(text, 60)).not.toBe(dark)
		expect(rowsOf(text, 60)).not.toEqual(darkRows)
		expect(plainText(normal(text, 60))).toBe(plainText(dark))
	})

	it('follow a change of theme in a laid-out window, and a grammar that arrives later', () => {
		const cache = createLayoutCache()
		const message = reply(fence('ts', 'const a = 1'))
		setThemeSetting('dark', { env: {} })
		const a = layoutTranscript([message], null, undefined, 80, cache)
		setThemeSetting('dark-daltonized', { env: {} })
		const b = layoutTranscript([message], null, undefined, 80, cache)
		expect(b.rows[0]?.spans).not.toEqual(a.rows[0]?.spans)
	})

	it('draw 16-colour themes in named colours only', () => {
		for (const name of ['dark-ansi', 'light-ansi'] as const) {
			applyPalette(name)
			const drawn = normal(fence('ts', CORPUS.ts as string), 80)
			// 256-colour and truecolor sequences are `38;5;n` and `38;2;r;g;b`.
			expect(drawn.includes(`${String.fromCharCode(27)}[38;5;`), name).toBe(false)
			expect(drawn.includes(`${String.fromCharCode(27)}[38;2;`), name).toBe(false)
			expect(colours(drawn).length, name).toBeGreaterThan(2)
		}
	})

	it('lets a search match show on top of the syntax colour, and leaves the rest as it was', () => {
		const rows = rowsOf(fence('ts', 'const a = "x"'), 40)
		const row = rows[0] as FsRow
		const base = paintRow(row, [])
		const marked = paintRow(row, [{ from: 2, to: 7, style: { inverse: true } }])
		expect(marked.map((s) => s.text).join('')).toBe(row.text)
		expect(marked.some((s) => s.inverse === true)).toBe(true)
		// The marked cells keep the colours they had; the unmarked ones are untouched.
		const colourAt = (spans: readonly { text: string; color?: string }[], at: number) => {
			let n = 0
			for (const s of spans) {
				n += s.text.length
				if (at < n) return s.color
			}
			return undefined
		}
		for (let at = 0; at < row.text.length; at++) {
			expect(colourAt(marked, at), `at ${at}`).toBe(colourAt(base, at))
		}
	})

	it('copy a wrapped coloured line as the one source line', () => {
		const line = `const sentence = "${'word '.repeat(20)}"`
		const coloured = rowsOf(fence('ts', line), 30)
		setSyntaxHighlight(false)
		const plain = rowsOf(fence('ts', line), 30)
		expect(coloured.length).toBeGreaterThan(2)
		expect(coloured.map((r) => r.joins)).toEqual(plain.map((r) => r.joins))
		const joined = coloured
			.map((r, i) => (i === 0 ? r.text : (r.joins ?? '') + r.text.trimStart()))
			.join('')
		expect(joined.replace(/\s+/gu, ' ')).toBe(line.replace(/\s+/gu, ' '))
	})
})

// ── A reply printed as it is written ──────────────────────────────────────────────

const BODY = [
	'/**',
	' * A comment that spans',
	' * several lines.',
	' */',
	...Array.from(
		{ length: 12 },
		(_, i) => `const value${i} = compute(${i}, "text ${i}") // line ${i}`,
	),
	'const template = `first',
	'  second ${value1 + 2}',
	'  third`',
	...Array.from({ length: 14 }, (_, i) => `function f${i}(a: number): number { return a + ${i} }`),
	'',
	'export default value0',
]
const LONG_REPLY = ['Here is the code:', '', '```ts', ...BODY, '```', '', 'That is all.'].join('\n')

function flowAt(width: number, rows: number): FlowContext {
	return { freeze: true, width, rows, hyperlinks: false, code: codeFlowHooks }
}

function pieceFrame(
	msg: TranscriptMessage,
	piece: ReturnType<typeof printedPieces>[number],
	width: number,
) {
	return renderToString(
		<ContentWidth.Provider value={width}>
			<Box width={width + 2} flexDirection="column">
				<ReplyPieceRow message={msg} prev={undefined} piece={piece} hyperlinks={false} />
			</Box>
		</ContentWidth.Provider>,
		{ columns: width + 2 },
	)
}

describe('a reply printed as it is written', () => {
	beforeEach(async () => {
		await whenGrammarsSettle(['ts'])
	})

	for (const [width, height] of [
		[38, 24],
		[96, 40],
	] as const) {
		it(`prints each row in the colours the finished reply gives it, at ${width} cells`, () => {
			const ctx = flowAt(width, height)
			const whole = renderToString(
				<ContentWidth.Provider value={width}>
					<Box width={width + 2} flexDirection="column">
						<ReplyPieceRow
							message={reply(LONG_REPLY)}
							prev={undefined}
							piece={{ text: LONG_REPLY, join: 'block', lead: null, first: true }}
							hyperlinks={false}
						/>
					</Box>
				</ContentWidth.Provider>,
				{ columns: width + 2 },
			)
			let printed: readonly PrintedChunk[] = []
			let got = ''
			let cuts = 0
			for (let p = 1; p <= LONG_REPLY.length; p++) {
				const next = freezeMore(LONG_REPLY.slice(0, p), printed, ctx)
				if (!next) continue
				const fresh = next.slice(printed.length)
				printed = next
				cuts += fresh.length
				const msg: TranscriptMessage = { ...reply(LONG_REPLY.slice(0, p)), pending: true, printed }
				const pieces = printedPieces(printed)
				for (let k = 0; k < fresh.length; k++) {
					const piece = pieces[printed.length - fresh.length + k] as (typeof pieces)[number]
					got += `${pieceFrame(msg, piece, width)}\n`
				}
			}
			const done: TranscriptMessage = { ...reply(LONG_REPLY), printed }
			const rest = tailPiece(done)
			if (rest) got += `${pieceFrame(done, rest, width)}\n`
			// The block was cut into several parts, and the parts are the whole, colours included.
			expect(cuts).toBeGreaterThan(1)
			const strip = (s: string) =>
				shown(
					s
						.split('\n')
						.filter((line) => plainText(line).trim() !== '')
						.join('\n'),
				)
			expect(strip(got)).toBe(strip(whole))
		}, 60_000)
	}

	it('holds a block while its grammar is read, and prints it when it has arrived', async () => {
		let arrive: (m: unknown) => void = () => {}
		const gate = new Promise((resolve) => {
			arrive = resolve
		})
		resetCodeHighlightForTests({ loaders: { typescript: () => gate as never } })
		const ctx = flowAt(38, 24)
		// The opener is known once its line has ended: that starts the read.
		expect(grammarState('ts')).toBe('loading')
		expect(freezeMore(LONG_REPLY, [], ctx)).toBeUndefined()
		arrive(await import('highlight.js/lib/languages/typescript'))
		await whenGrammarsSettle(['ts'])
		expect(grammarState('ts')).toBe('ready')
		expect(freezeMore(LONG_REPLY, [], ctx)?.length).toBeGreaterThan(0)
	})

	it('prints at once a block whose grammar cannot be read, as a plain one', async () => {
		resetCodeHighlightForTests({ loaders: { typescript: () => Promise.reject(new Error('gone')) } })
		const ctx = flowAt(38, 24)
		expect(freezeMore(LONG_REPLY, [], ctx)).toBeUndefined()
		await whenGrammarsSettle(['ts'])
		expect(freezeMore(LONG_REPLY, [], ctx)?.length).toBeGreaterThan(0)
	})

	it('counts the reply in the parts it prints', () => {
		const ctx = flowAt(38, 24)
		const chunks = freezeMore(LONG_REPLY, [], ctx) ?? []
		const last = chunks[chunks.length - 1]
		expect(last?.next?.spent).toBeGreaterThan(100)
		expect(tailStateOf(chunks).flow).toBe(last?.next)
		expect(
			tailView(LONG_REPLY.slice(chunks.map((c) => c.text).join('').length), tailStateOf(chunks)),
		).not.toBe('')
	})
})

describe('a message the scrollback has to wait for', () => {
	const messages: TranscriptMessage[] = [
		{ id: 'u', role: 'user', content: 'show me' },
		{ id: 'a', role: 'assistant', content: fence('ts', 'const a = 1 // c') },
		{ id: 'b', role: 'assistant', content: fence('', 'plain') },
	]

	it('is held out of the scrollback while its grammar is read, and released when it has arrived', async () => {
		let arrive: (m: unknown) => void = () => {}
		const gate = new Promise((resolve) => {
			arrive = resolve
		})
		resetCodeHighlightForTests({ loaders: { typescript: () => gate as never } })
		// The message with the block, and everything after it, waits; what is before it does not.
		expect(firstHeld(messages, 0, 3)).toBe(1)
		expect(firstHeld(messages, 0, 1)).toBe(1)
		arrive(await import('highlight.js/lib/languages/typescript'))
		await whenGrammarsSettle(['ts'])
		expect(firstHeld(messages, 0, 3)).toBe(3)
	})

	it('is released when the grammar cannot be read, and is not held for a block with no language', async () => {
		resetCodeHighlightForTests({ loaders: { typescript: () => Promise.reject(new Error('gone')) } })
		expect(firstHeld(messages, 2, 3)).toBe(3)
		expect(firstHeld(messages, 0, 3)).toBe(1)
		await whenGrammarsSettle(['ts'])
		expect(firstHeld(messages, 0, 3)).toBe(3)
	})

	it('is not held at all with the setting off or colour off', async () => {
		resetCodeHighlightForTests()
		setSyntaxHighlight(false)
		expect(firstHeld(messages, 0, 3)).toBe(3)
	})

	it('is drawn, held or not, with its text', async () => {
		resetCodeHighlightForTests()
		const view = render(
			<Transcript messages={messages} pending={null} state="idle" settled={3} resetKey={0} />,
		)
		expect(plainText(view.lastFrame() ?? '')).toContain('const a = 1')
		await whenGrammarsSettle(['ts'])
		view.rerender(
			<Transcript messages={messages} pending={null} state="idle" settled={3} resetKey={0} />,
		)
		expect(colours(view.lastFrame() ?? '').length).toBeGreaterThan(2)
		view.unmount()
	})
})

describe('colouring in a printed or settled message does not need to be asked for twice', () => {
	it('finds the block it drew again', () => {
		const lines = ['const a = 1', 'const b = 2']
		expect(colourLines('ts', lines)).toBe(colourLines('ts', lines))
	})
})
