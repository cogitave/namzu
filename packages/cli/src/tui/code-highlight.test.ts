/**
 * The highlighter module: which words name a grammar, how a grammar is read (and what a
 * block does while it is not, and when it cannot be), what a block's runs are, that they are
 * the same whole and a part at a time, and what the limits decide.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Colour on: `colourWanted` is false under CI without it.
vi.hoisted(() => {
	process.env.FORCE_COLOR = '3'
})

import { CORPUS, FENCE_WORD } from './__tests__/code-corpus.js'
import {
	type CodeFlow,
	type CodeLine,
	GRAMMAR_WAIT_MS,
	KNOWN_LANGUAGE_WORDS,
	MAX_BLOCK_CHARS,
	MAX_LINE_CHARS,
	MAX_REPLY_CHARS,
	NO_FLOW,
	STOPPED,
	colourLines,
	colourWanted,
	colourableLines,
	flowAfter,
	grammarOf,
	grammarState,
	grammarVersion,
	languagesIn,
	readInOneCall,
	resetCodeHighlightForTests,
	runsForPieces,
	setSyntaxHighlight,
	subscribeGrammars,
	whenGrammarsSettle,
} from './code-highlight.js'

const text = (line: CodeLine): string => line.map((run) => run.text).join('')
const lines = (source: string): string[] => source.split('\n')

describe('the language words', () => {
	it('maps the usual short names to a grammar', () => {
		const names: Record<string, string> = {
			js: 'javascript',
			jsx: 'javascript',
			ts: 'typescript',
			tsx: 'typescript',
			py: 'python',
			rb: 'ruby',
			rs: 'rust',
			sh: 'bash',
			zsh: 'bash',
			yml: 'yaml',
			toml: 'ini',
			html: 'xml',
			md: 'markdown',
			'c++': 'cpp',
			'c#': 'csharp',
			golang: 'go',
			jsonc: 'json',
			patch: 'diff',
			dockerfile: 'dockerfile',
			powershell: 'powershell',
			pwsh: 'powershell',
			TypeScript: 'typescript',
			'ts:src/a.ts': 'typescript',
			'ts{1,3}': 'typescript',
		}
		for (const [word, grammar] of Object.entries(names)) expect(grammarOf(word), word).toBe(grammar)
	})

	it('knows no grammar for none, a plain-text word, or a word it does not have', () => {
		for (const word of [
			undefined,
			'',
			'text',
			'txt',
			'plaintext',
			'plain',
			'klingon',
			'constructor',
			'__proto__',
		]) {
			expect(grammarOf(word), String(word)).toBeUndefined()
		}
	})

	it('lists every word it draws, each naming a grammar', () => {
		expect(KNOWN_LANGUAGE_WORDS.length).toBeGreaterThan(80)
		for (const word of KNOWN_LANGUAGE_WORDS) expect(grammarOf(word), word).toBeDefined()
	})

	it('finds the languages of the fences in a text without parsing it', () => {
		expect(languagesIn('no fence here')).toEqual([])
		expect(languagesIn('a\n```ts\nx\n```\n\n~~~py\ny\n~~~\n  ```bash title=x\n')).toEqual([
			'ts',
			'py',
			'bash',
		])
		expect(languagesIn('```\nplain\n```')).toEqual([])
	})
})

describe('reading a grammar', () => {
	beforeEach(() => resetCodeHighlightForTests())
	afterEach(() => {
		vi.useRealTimers()
		resetCodeHighlightForTests()
	})

	it('is plain for a word with no grammar, and loading then ready for one that has', async () => {
		expect(grammarState('klingon')).toBe('plain')
		expect(grammarState(undefined)).toBe('plain')
		expect(grammarState('ts')).toBe('loading')
		await whenGrammarsSettle(['ts'])
		expect(grammarState('ts')).toBe('ready')
		expect(grammarState('typescript')).toBe('ready')
	})

	it('tells a subscriber when a grammar has arrived', async () => {
		const seen: number[] = []
		const stop = subscribeGrammars(() => seen.push(grammarVersion()))
		grammarState('py')
		await whenGrammarsSettle(['py'])
		stop()
		expect(seen.length).toBeGreaterThan(0)
	})

	it('loads the grammars a grammar reads inside itself, with it', async () => {
		await whenGrammarsSettle(['md'])
		expect(colourLines('md', lines('# Title\n\n<div class="a">x</div>'))).toBeDefined()
		await whenGrammarsSettle(['console'])
		const shell = colourLines('console', ['$ echo "hi" && ls'])
		expect(shell?.lines[0]?.some((run) => run.kind !== undefined)).toBe(true)
	})

	it('is plain for the session when the grammar cannot be read, with nothing thrown', async () => {
		resetCodeHighlightForTests({
			loaders: { python: () => Promise.reject(new Error('the file is gone')) },
		})
		expect(grammarState('py')).toBe('loading')
		await whenGrammarsSettle(['py'])
		expect(grammarState('py')).toBe('plain')
		expect(colourLines('py', ['x = 1'])).toBeUndefined()
		// Asking again does not try again.
		expect(grammarState('py')).toBe('plain')
	})

	it('is plain for the session when the grammar is not a grammar', async () => {
		resetCodeHighlightForTests({
			loaders: {
				python: () =>
					Promise.resolve({
						default: (() => {
							throw new Error('boom')
						}) as never,
					}),
			},
		})
		await whenGrammarsSettle(['py'])
		expect(grammarState('py')).toBe('plain')
	})

	it('is plain for the session when a grammar throws as it reads', async () => {
		resetCodeHighlightForTests({
			loaders: {
				python: () =>
					Promise.resolve({
						default: (() => ({
							contains: [
								{
									get begin(): RegExp {
										throw new Error('boom')
									},
								},
							],
						})) as never,
					}),
			},
		})
		await whenGrammarsSettle(['py'])
		expect(() => colourLines('py', ['x = 1', 'y = 2'])).not.toThrow()
		expect(colourLines('py', ['x = 1', 'y = 2'])).toBeUndefined()
		expect(grammarState('py')).toBe('plain')
	})

	it('gives up on a grammar that does not arrive in time, and ignores it if it comes after', async () => {
		vi.useFakeTimers()
		let arrive: (m: { default: never }) => void = () => {}
		const python = import('highlight.js/lib/languages/python')
		resetCodeHighlightForTests({
			loaders: {
				python: () =>
					new Promise((resolve) => {
						arrive = resolve as never
					}),
			},
		})
		expect(grammarState('py')).toBe('loading')
		vi.advanceTimersByTime(GRAMMAR_WAIT_MS - 1)
		expect(grammarState('py')).toBe('loading')
		vi.advanceTimersByTime(1)
		expect(grammarState('py')).toBe('plain')
		arrive((await python) as never)
		await vi.advanceTimersByTimeAsync(10)
		expect(grammarState('py')).toBe('plain')
	})

	it('draws nothing in colour when the setting is off, and tells subscribers', async () => {
		await whenGrammarsSettle(['ts'])
		expect(colourLines('ts', ['const a = 1'])).toBeDefined()
		const seen: number[] = []
		const stop = subscribeGrammars(() => seen.push(1))
		setSyntaxHighlight(false)
		expect(seen.length).toBe(1)
		expect(grammarState('ts')).toBe('plain')
		expect(colourLines('ts', ['const a = 1'])).toBeUndefined()
		setSyntaxHighlight(true)
		stop()
		expect(colourLines('ts', ['const a = 1'])).toBeDefined()
	})

	it('writes no colour where colour is off', () => {
		const tty = true
		expect(colourWanted({ FORCE_COLOR: '3' }, tty)).toBe(true)
		expect(colourWanted({}, tty)).toBe(true)
		expect(colourWanted({}, false)).toBe(false)
		expect(colourWanted({ NO_COLOR: '1' }, tty)).toBe(false)
		expect(colourWanted({ NO_COLOR: '1', FORCE_COLOR: '3' }, tty)).toBe(false)
		expect(colourWanted({ FORCE_COLOR: '0' }, tty)).toBe(false)
		expect(colourWanted({ TERM: 'dumb' }, tty)).toBe(false)
		expect(colourWanted({ CI: 'true' }, tty)).toBe(false)
		expect(colourWanted({ CI: 'true', FORCE_COLOR: '1' }, tty)).toBe(true)
	})

	it('does no work at all under NO_COLOR', async () => {
		await whenGrammarsSettle(['ts'])
		const keep = { ...process.env }
		try {
			process.env.NO_COLOR = '1'
			expect(grammarState('ts')).toBe('plain')
			expect(colourLines('ts', ['const a = 1'])).toBeUndefined()
		} finally {
			// biome-ignore lint/performance/noDelete: an env var set to undefined would read as "undefined"
			delete process.env.NO_COLOR
			process.env.FORCE_COLOR = keep.FORCE_COLOR
		}
	})
})

describe('the runs of a block', () => {
	beforeAll(async () => {
		resetCodeHighlightForTests()
		await whenGrammarsSettle(Object.values(FENCE_WORD))
	})

	it('are the line, in kinds, for every language of the corpus', () => {
		for (const [name, source] of Object.entries(CORPUS)) {
			const word = FENCE_WORD[name] as string
			const input = lines(source)
			const got = colourLines(word, input)
			expect(got, name).toBeDefined()
			expect(got?.lines.length, name).toBe(input.length)
			input.forEach((line, i) => expect(text(got?.lines[i] ?? []), `${name}:${i}`).toBe(line))
		}
	})

	it('colour keywords, strings, numbers, comments, names, types and literals', () => {
		const kinds = new Set<string>()
		const got = colourLines('ts', lines(CORPUS.ts as string))
		for (const line of got?.lines ?? []) for (const run of line) if (run.kind) kinds.add(run.kind)
		for (const kind of ['keyword', 'string', 'number', 'comment', 'name', 'type', 'literal']) {
			expect(kinds.has(kind), kind).toBe(true)
		}
	})

	it('colour the added and removed lines of a diff', () => {
		const got = colourLines('diff', lines(CORPUS.diff as string))
		const kindOf = (n: number) => got?.lines[n]?.find((run) => run.kind)?.kind
		expect(kindOf(5)).toBe('removed')
		expect(kindOf(6)).toBe('added')
		expect(kindOf(4)).toBeUndefined()
	})

	it('keep a multi-line comment, string and docstring in one kind across the break', () => {
		const ts = colourLines('ts', lines(CORPUS.ts as string))
		expect(ts?.lines[2]?.every((run) => run.kind === 'comment')).toBe(true)
		expect(ts?.lines[3]?.every((run) => run.kind === 'comment')).toBe(true)
		expect(ts?.lines[9]?.some((run) => run.kind === 'string')).toBe(true)
		const py = colourLines('py', lines(CORPUS.python as string))
		expect(py?.lines[5]?.some((run) => run.kind === 'string')).toBe(true)
	})

	it('are the same as one call of the library over the whole block', () => {
		for (const [name, source] of Object.entries(CORPUS)) {
			const word = FENCE_WORD[name] as string
			const input = lines(source)
			const windowed = colourLines(word, input)?.lines
			const once = readInOneCall(word, input)
			expect(windowed, name).toEqual(once)
		}
	})

	// The library decides a few tokens by reading ahead over several lines (a raw string, a
	// heredoc, a block scalar). A printed part cannot read ahead of its last line, so a cut that
	// falls inside such a token colours the lines before it as code. Stated in the docs; the
	// whole-block read is exact for them (the test above).
	const READS_AHEAD = new Set(['rust', 'ruby', 'yaml'])

	it('are the same drawn a part at a time as drawn whole, wherever the parts are cut', () => {
		for (const [name, source] of Object.entries(CORPUS)) {
			const word = FENCE_WORD[name] as string
			const input = lines(source)
			const whole = colourLines(word, input)?.lines
			for (const step of [1, 2, 3, 5, 7, input.length]) {
				let flow: CodeFlow = NO_FLOW
				const parts: (CodeLine | undefined)[] = []
				for (let at = 0; at < input.length; at += step) {
					const part = input.slice(at, at + step)
					parts.push(...(colourLines(word, part, flow)?.lines ?? part.map(() => undefined)))
					flow = flowAfter(word, flow, part)
				}
				if (READS_AHEAD.has(name) && step < input.length) {
					expect(
						parts.map((line) => (line ? text(line) : '')),
						`${name} by ${step}`,
					).toEqual(input)
				} else expect(parts, `${name} by ${step}`).toEqual(whole)
			}
		}
	})

	it('carry a template literal across the cut, and drop it once it has closed', () => {
		const input = lines(CORPUS.ts as string)
		let flow: CodeFlow = NO_FLOW
		// Up to and including the line that opens the template literal.
		flow = flowAfter('ts', flow, input.slice(0, 8))
		expect(flow.above.endsWith(input[7] as string)).toBe(true)
		const next = flowAfter('ts', flow, input.slice(8, 9))
		expect(next.above.endsWith(`${input[7]}\n${input[8]}`)).toBe(true)
		const closed = flowAfter('ts', next, input.slice(9, 10))
		expect(closed.above).toBe('')
	})

	it('are found again for a block that is drawn again, and read from where they were cut as it grows', () => {
		const input = lines(CORPUS.ts as string)
		const first = colourLines('ts', input)
		expect(colourLines('ts', input)).toBe(first)
		for (let n = 1; n <= input.length; n++) {
			const prefix = colourLines('ts', input.slice(0, n))?.lines
			expect(prefix, `prefix ${n}`).toEqual(first?.lines.slice(0, n))
		}
	})

	it('are the same in a partial last line as in the finished one, up to what was written', () => {
		const source = 'const message = "hello world"; // done'
		const finished = colourLines('ts', [source])?.lines[0] as CodeLine
		const kindAt = (line: CodeLine, at: number) => {
			let n = 0
			for (const run of line) {
				n += run.text.length
				if (at < n) return run.kind
			}
			return undefined
		}
		for (let cut = 1; cut < source.length; cut++) {
			const partial = colourLines('ts', [source.slice(0, cut)])?.lines[0] as CodeLine
			expect(text(partial)).toBe(source.slice(0, cut))
			// What has been written is coloured as it will be, but for the last token it ends in.
			for (let at = 0; at < cut - 8; at++)
				expect(kindAt(partial, at), `${cut}:${at}`).toBe(kindAt(finished, at))
		}
	})
})

describe('cutting a block into the lines of its wrapped rows', () => {
	it('gives each row its own characters in the kinds the line gave them', () => {
		const runs: CodeLine = [
			{ text: 'const', kind: 'keyword' },
			{ text: ' a = ' },
			{ text: '"a long string"', kind: 'string' },
		]
		const line = 'const a = "a long string"'
		const cut = runsForPieces(line, runs, ['const a = "a l', 'ong string"'])
		expect(cut.map((piece) => (piece ? text(piece) : null))).toEqual([
			'const a = "a l',
			'ong string"',
		])
		expect(cut[0]?.map((run) => run.kind)).toEqual(['keyword', undefined, 'string'])
		expect(cut[1]?.map((run) => run.kind)).toEqual(['string'])
	})

	it('finds a row after the blanks the wrapper dropped, and gives up on one it cannot find', () => {
		const runs: CodeLine = [{ text: 'a b c', kind: 'keyword' }]
		expect(runsForPieces('a b c', runs, ['a', 'b c']).map((p) => (p ? text(p) : null))).toEqual([
			'a',
			'b c',
		])
		expect(runsForPieces('a b c', runs, ['a', 'zzz'])[1]).toBeUndefined()
		expect(runsForPieces('', [], [' '])).toEqual([[]])
	})
})

describe('the limits', () => {
	const flowOf = (spent: number, block: number) => ({ spent, block })

	it('colour the lines above the first one past a limit, and only those', () => {
		const long = 'x '.repeat(MAX_LINE_CHARS)
		expect(colourableLines(['a', 'b', long, 'c'])).toBe(2)
		expect(colourableLines(['a', 'b'])).toBe(2)
		expect(colourableLines([])).toBe(0)
		expect(colourableLines(['a'.repeat(MAX_LINE_CHARS + 1)])).toBe(0)
		expect(colourableLines([`${'ab '.repeat(MAX_LINE_CHARS / 3)}`])).toBe(1)
	})

	it('end the colouring of a line that is one long word (a blob), not of a long line of code', () => {
		expect(colourableLines(['a'.repeat(150)])).toBe(0)
		expect(colourableLines([`${'ab '.repeat(120)}`])).toBe(1)
		expect(colourableLines(['漢'.repeat(150)])).toBe(0)
	})

	it('end the colouring of a block at the characters it may have, and of a reply at its own', () => {
		const line = 'a'.repeat(79)
		const room = Math.floor(MAX_BLOCK_CHARS / 80)
		expect(colourableLines(Array(room + 5).fill(line))).toBe(room)
		expect(colourableLines(Array(10).fill(line), flowOf(0, MAX_BLOCK_CHARS - 80 * 3))).toBe(3)
		expect(colourableLines(Array(10).fill(line), flowOf(MAX_REPLY_CHARS - 80 * 4, 0))).toBe(4)
	})

	it('decide a line by what is above it, so a block cut anywhere gets the same lines', () => {
		const input = ['a', 'b', 'x '.repeat(MAX_LINE_CHARS), 'c', 'd']
		const whole = colourableLines(input)
		let flow: CodeFlow = NO_FLOW
		let got = 0
		for (const part of [input.slice(0, 1), input.slice(1, 3), input.slice(3)]) {
			const n = colourableLines(part, flow)
			got += n
			flow = flowAfter(undefined, flow, part)
			if (n < part.length) break
		}
		expect(got).toBe(whole)
	})

	it('end the colouring for the rest of a block once a part has gone past a limit', async () => {
		await whenGrammarsSettle(['ts'])
		const long = 'x '.repeat(MAX_LINE_CHARS)
		let flow: CodeFlow = flowAfter('ts', NO_FLOW, ['a', long])
		expect(flow.above).toBe(STOPPED)
		expect(colourLines('ts', ['const a = 1'], flow)).toBeUndefined()
		flow = flowAfter('ts', flow, ['const b = 2'])
		expect(flow.above).toBe(STOPPED)
		// The characters keep being counted.
		expect(flow.spent).toBeGreaterThan(MAX_LINE_CHARS)
	})

	it('colour no line at all for a language that is not ready, and say nothing', () => {
		expect(colourLines('klingon', ['a'])).toBeUndefined()
		expect(colourLines(undefined, ['a'])).toBeUndefined()
	})
})
