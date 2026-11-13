/**
 * The worst inputs for each grammar the highlighter ships, at the sizes its limits allow.
 *
 * A grammar is a set of regular expressions, and a long run of one character, of quotes, of
 * backslashes, of opening brackets, an unterminated string or comment or a deeply nested
 * template is what makes one of them backtrack. Nothing here measures time (a test that
 * races the clock measures the machine); it asserts the decisions that bound the time: how
 * much of a block is handed to the library, and in how large a piece. The measured times are
 * in the notes of the change, taken with `observeLibraryCalls`, which this test uses to
 * count characters.
 *
 * Adding a grammar to the highlighter means adding it to `code-highlight.ts` and then running
 * it through this file: every grammar that can be named is listed from the module itself.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.FORCE_COLOR = '3'
})

import {
	GRAMMAR_WAIT_MS,
	KNOWN_LANGUAGE_WORDS,
	MAX_BLOCK_CHARS,
	MAX_LINE_CHARS,
	OPEN_LIMIT,
	colourLines,
	colourableLines,
	grammarOf,
	grammarState,
	observeLibraryCalls,
	resetCodeHighlightForTests,
	whenGrammarsSettle,
} from './code-highlight.js'

const rep = (s: string, n: number): string => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const L = MAX_LINE_CHARS

/** Each input as a function of how many lines of it to make. */
const INPUTS: Readonly<Record<string, (lines: number) => string[]>> = {
	'one character': (n) => Array(n).fill(rep('a', L)),
	quotes: (n) => Array(n).fill(rep('"', L)),
	'single quotes': (n) => Array(n).fill(rep("'", L)),
	backticks: (n) => Array(n).fill(rep('`', L)),
	backslashes: (n) => Array(n).fill(rep('\\', L)),
	'opening brackets': (n) => Array(n).fill(rep('(', L)),
	'opening braces': (n) => Array(n).fill(rep('{', L)),
	'opening angle brackets': (n) => Array(n).fill(rep('<', L)),
	'opening square brackets': (n) => Array(n).fill(rep('[', L)),
	slashes: (n) => Array(n).fill(rep('/', L)),
	'comment openers': (n) => Array(n).fill(rep('/*', L)),
	'unterminated strings': (n) => Array(n).fill(`x = "${rep('ab', L - 5)}`),
	'unterminated comment': (n) => ['/*', ...Array(n).fill(rep('c ', L))],
	'unterminated docstring': (n) => ['"""', ...Array(n).fill(rep('c ', L))],
	'nested templates': (n) => Array(n).fill(rep('`${', L)),
	'triple quotes': (n) => Array(n).fill(rep('"""', L)),
	'dollar parens': (n) => Array(n).fill(rep('$(', L)),
	words: (n) => Array(n).fill(rep('ab ', L)),
	calls: (n) => Array(n).fill(rep('f(', L)),
	'dotted names': (n) => Array(n).fill(rep('a.', L)),
	generics: (n) => Array(n).fill(rep('A<', L)),
	arrows: (n) => Array(n).fill(rep('=>', L)),
	operators: (n) => Array(n).fill(rep('+', L)),
	'tag soup': (n) => Array(n).fill(rep('<a ', L)),
	equals: (n) => Array(n).fill(rep('=', L)),
	'word runs at the limit': (n) => Array(n).fill(rep(`${rep('a', 99)} `, L)),
	'long word runs': (n) => Array(n).fill(rep('a', L)),
	'heredoc openers': (n) => Array(n).fill(rep('<<EOF ', L)),
}

/** Every grammar a word can name, with a word for it. */
const GRAMMARS = new Map<string, string>()
for (const word of KNOWN_LANGUAGE_WORDS) {
	const id = grammarOf(word)
	if (id !== undefined && !GRAMMARS.has(id)) GRAMMARS.set(id, word)
}

// The sizes the library may be handed in one call: a window of 32 lines or 4,000 characters,
// grown while it is inside something unclosed up to the open limit and no further, and the
// lookahead read past a window.
const MOST_IN_ONE_CALL = OPEN_LIMIT + 10 * L + 4_000

beforeAll(async () => {
	resetCodeHighlightForTests()
	await whenGrammarsSettle([...GRAMMARS.values()])
})

describe('the worst inputs for every grammar', () => {
	it('ships the common set, dockerfile and powershell', () => {
		expect([...GRAMMARS.keys()].sort()).toEqual(
			[
				'bash',
				'c',
				'cpp',
				'csharp',
				'css',
				'diff',
				'dockerfile',
				'go',
				'graphql',
				'ini',
				'java',
				'javascript',
				'json',
				'kotlin',
				'less',
				'lua',
				'makefile',
				'markdown',
				'objectivec',
				'perl',
				'php',
				'php-template',
				'powershell',
				'python',
				'python-repl',
				'r',
				'ruby',
				'rust',
				'scss',
				'shell',
				'sql',
				'swift',
				'typescript',
				'vbnet',
				'wasm',
				'xml',
				'yaml',
			].sort(),
		)
	})

	for (const [id, word] of GRAMMARS) {
		it(`${id}: hands the library bounded pieces of a bounded part of every input`, () => {
			expect(grammarState(word)).toBe('ready')
			for (const [name, make] of Object.entries(INPUTS)) {
				// At the size the block limit allows, and cut off there.
				const full = make(Math.ceil(MAX_BLOCK_CHARS / L) + 5)
				const allowed = colourableLines(full, undefined, word)
				const chars = full.slice(0, allowed).reduce((n, line) => n + line.length + 1, 0)
				expect(chars, `${id} ${name}`).toBeLessThanOrEqual(MAX_BLOCK_CHARS)
				// A smaller block of the same input, read for real.
				const lines = make(12)
				let biggest = 0
				let total = 0
				observeLibraryCalls((_id, size) => {
					biggest = Math.max(biggest, size)
					total += size
				})
				try {
					const got = colourLines(word, lines)
					const text = (got?.lines ?? []).map((l) => l.map((r) => r.text).join(''))
					expect(text, `${id} ${name}`).toEqual(lines.slice(0, text.length))
				} finally {
					observeLibraryCalls(undefined)
				}
				const wanted = colourableLines(lines, undefined, word)
				const bytes = lines.slice(0, wanted).reduce((n, line) => n + line.length + 1, 0)
				expect(biggest, `${id} ${name} largest call`).toBeLessThanOrEqual(MOST_IN_ONE_CALL)
				// Read a few times over at the most, whatever the input.
				expect(total, `${id} ${name} total`).toBeLessThanOrEqual(8 * bytes + 4 * OPEN_LIMIT)
			}
		})
	}

	it('never lets a block past the limits reach the library whole', () => {
		const normal = Array(5_000).fill('a'.repeat(79))
		expect(colourableLines(normal) * 80).toBeLessThanOrEqual(MAX_BLOCK_CHARS)
		expect(colourableLines(normal)).toBeGreaterThan(0)
	})

	it('waits for a grammar no longer than the bound', () => {
		expect(GRAMMAR_WAIT_MS).toBeLessThanOrEqual(2_000)
	})
})
