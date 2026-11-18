import { describe, expect, it, vi } from 'vitest'
import {
	type EngineLoader,
	type HighlightEngine,
	MAX_HIGHLIGHT_CHARS,
	MAX_HIGHLIGHT_LINES,
	blockIsSettled,
	createBlockHighlighter,
	hasFence,
	highlightLanguage,
	themeForMode,
} from './code-highlight.js'

const KNOWN = new Set(['ts', 'typescript', 'sh', 'json'])

/** A fake highlighter: one token per line, coloured by the theme it was asked for. */
function fake(): { load: EngineLoader; engine: HighlightEngine } {
	const engine: HighlightEngine = {
		codeToTokens: vi.fn((code: string, { theme }: { lang: string; theme: string }) => ({
			tokens: code.split('\n').map((line) => [{ content: line, color: `color-of-${theme}` }]),
		})),
	}
	const load: EngineLoader = vi.fn(async (_theme, lang) => {
		if (!KNOWN.has(lang)) throw new Error(`unknown language ${lang}`)
		return engine
	})
	return { load, engine }
}

describe('which blocks of a reply are coloured', () => {
	it('leaves the tail of a streaming reply plain and settles every block once it is done', () => {
		expect(blockIsSettled(0, 3, false, false)).toBe(true)
		expect(blockIsSettled(1, 3, false, false)).toBe(true)
		expect(blockIsSettled(2, 3, false, false)).toBe(false)
		expect(blockIsSettled(2, 3, true, false)).toBe(true)
		expect(blockIsSettled(0, 1, false, true)).toBe(true)
	})
})

describe('which blocks can hold code to colour', () => {
	it('is only a block with a fence, so other blocks keep their parsed tree as a reply grows', () => {
		expect(hasFence('```ts\nlet a\n```')).toBe(true)
		expect(hasFence('~~~sh\nls\n~~~')).toBe(true)
		expect(hasFence('Plain `code` and text')).toBe(false)
	})
})

describe('the language of a fence', () => {
	it('keeps the name the highlighter resolves itself, lower-cased', () => {
		expect(highlightLanguage('x', 'TS')).toBe('ts')
		expect(highlightLanguage('x', ' bash ')).toBe('bash')
		expect(highlightLanguage('x', 'c++')).toBe('c++')
	})
	it('keeps a block plain when it names no language or plain text', () => {
		for (const fence of ['', '  ', 'text', 'txt', 'plaintext', 'ansi']) {
			expect(highlightLanguage('x', fence)).toBeUndefined()
		}
	})
	it('keeps a block plain when the name is not a plain identifier', () => {
		expect(highlightLanguage('x', '../../etc')).toBeUndefined()
		expect(highlightLanguage('x', 'a b')).toBeUndefined()
	})
	it('keeps a block over the size caps plain', () => {
		expect(highlightLanguage('a'.repeat(MAX_HIGHLIGHT_CHARS), 'ts')).toBe('ts')
		expect(highlightLanguage('a'.repeat(MAX_HIGHLIGHT_CHARS + 1), 'ts')).toBeUndefined()
		expect(highlightLanguage('\n'.repeat(MAX_HIGHLIGHT_LINES - 1), 'ts')).toBe('ts')
		expect(highlightLanguage('\n'.repeat(MAX_HIGHLIGHT_LINES), 'ts')).toBeUndefined()
	})
})

describe('the block highlighter', () => {
	it('returns tokens that spell the original text, so a copy is unchanged', async () => {
		const { load } = fake()
		const text = 'const a = 1\n\n  return a  '
		const lines = await createBlockHighlighter(load).highlight(text, 'ts', 'pierre-light')
		expect(lines?.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(text)
	})

	it('stays plain when the tokens do not spell the text', async () => {
		const load: EngineLoader = async () => ({
			codeToTokens: () => ({ tokens: [[{ content: 'changed' }]] }),
		})
		expect(await createBlockHighlighter(load).highlight('original', 'ts', 't')).toBeUndefined()
	})

	it('stays plain for an unknown language, a loader that fails and a block with no language', async () => {
		const { load } = fake()
		const highlighter = createBlockHighlighter(load)
		expect(await highlighter.highlight('x', 'klingon', 't')).toBeUndefined()
		expect(await highlighter.highlight('x', '', 't')).toBeUndefined()
		const failing = createBlockHighlighter(async () => {
			throw new Error('no wasm')
		})
		expect(await failing.highlight('x', 'ts', 't')).toBeUndefined()
	})

	it('tries again after a load that failed for a reason other than the language', async () => {
		const { load: realLoad } = fake()
		let first = true
		const load = vi.fn(async (theme: string, lang: string) => {
			if (first) {
				first = false
				throw new Error('wasm did not load')
			}
			return realLoad(theme, lang)
		})
		const highlighter = createBlockHighlighter(load)
		expect(await highlighter.highlight('a', 'ts', 'light')).toBeUndefined()
		expect(await highlighter.highlight('a', 'ts', 'light')).toBeDefined()
		expect(load).toHaveBeenCalledTimes(2)
	})

	it('loads each theme and language once, also a failure', async () => {
		const { load } = fake()
		const highlighter = createBlockHighlighter(load)
		await highlighter.highlight('a', 'ts', 'light')
		await highlighter.highlight('b', 'ts', 'light')
		await highlighter.highlight('c', 'klingon', 'light')
		await highlighter.highlight('d', 'klingon', 'light')
		await highlighter.highlight('e', 'ts', 'dark')
		await highlighter.highlight('f', 'sh', 'light')
		expect(load).toHaveBeenCalledTimes(4)
		expect(load).toHaveBeenCalledWith('light', 'ts')
		expect(load).toHaveBeenCalledWith('dark', 'ts')
	})

	it('asks the engine for the theme it was given, so a changed choice recolours', async () => {
		const { load } = fake()
		const highlighter = createBlockHighlighter(load)
		const light = await highlighter.highlight('a', 'json', 'pierre-light')
		const dark = await highlighter.highlight('a', 'json', 'pierre-dark')
		expect(light?.[0]?.[0]?.color).toBe('color-of-pierre-light')
		expect(dark?.[0]?.[0]?.color).toBe('color-of-pierre-dark')
	})

	it('does not call the loader for a block over the cap', async () => {
		const { load } = fake()
		await createBlockHighlighter(load).highlight('a'.repeat(MAX_HIGHLIGHT_CHARS + 1), 'ts', 't')
		expect(load).not.toHaveBeenCalled()
	})
})

describe('the theme for the window', () => {
	it('takes the light set in a light window and the dark set in a dark one', () => {
		const prefs = { light: 'github-light-high-contrast', dark: 'gruvbox-dark-medium' }
		expect(themeForMode(prefs, false)).toBe('github-light-high-contrast')
		expect(themeForMode(prefs, true)).toBe('gruvbox-dark-medium')
	})
})
