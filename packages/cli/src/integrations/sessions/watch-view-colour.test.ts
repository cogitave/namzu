import { beforeEach, describe, expect, it, vi } from 'vitest'

// Colour on: `colourWanted` is false under CI without it.
vi.hoisted(() => {
	process.env.FORCE_COLOR = '3'
})

import { resetCodeHighlightForTests, setSyntaxHighlight } from '../../tui/code-highlight.js'
import type { TranscriptMessage } from '../../tui/types.js'
import type { SessionFollower, WatchSnapshot } from './session-watch.js'
import { WatchPrinter, colourFencedLines, follow, rowLines } from './watch-view.js'

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes to compare the text
const ANSI = /\u001b\[[0-9;]*m/gu

const SOURCE = [
	'Here it is:',
	'',
	'```ts',
	'const a = "x" // note',
	'```',
	'',
	'```',
	'plain block',
	'```',
	'done',
].join('\n')

beforeEach(() => resetCodeHighlightForTests())

function snapshot(content: string): WatchSnapshot {
	return {
		status: { state: 'finished', sentence: 'done', outcome: 'completed' },
		changed: true,
		messages: [
			{ role: 'user', content: 'show me' },
			{ role: 'assistant', content },
		],
		records: [],
	} as unknown as WatchSnapshot
}

async function watched(content: string, plain: boolean): Promise<string> {
	const out: string[] = []
	const printer = new WatchPrinter({
		write: (t) => out.push(t),
		plain,
		columns: 80,
		ended: 'exit',
	})
	const follower = { poll: async () => snapshot(content) } as unknown as SessionFollower
	await follow({
		follower,
		printer,
		cwd: '/work',
		exitOnEnd: true,
		signal: new AbortController().signal,
		wait: async () => {},
	})
	return out.join('')
}

describe('namzu watch draws a code block in syntax colour', () => {
	it('on the first paint, with the grammar read before anything is printed', async () => {
		const text = await watched(SOURCE, false)
		const line = text.split('\n').find((l) => l.includes('const'))
		expect(line).toBeDefined()
		expect(line).toMatch(/\u001b\[38;5;\d+mconst\u001b\[39m/u)
		expect(line?.replace(ANSI, '')).toBe('  const a = "x" // note')
	})

	it('never changes the characters, and leaves the fences and the other blocks alone', async () => {
		const text = await watched(SOURCE, false)
		const without = text.replace(ANSI, '')
		for (const line of SOURCE.split('\n').filter((l) => l !== '')) expect(without).toContain(line)
		expect(text.split('\n').find((l) => l.includes('plain block'))).toBe('  plain block')
	})

	it('writes no colour in plain mode, with the setting off, or under NO_COLOR', async () => {
		expect(await watched(SOURCE, true)).not.toMatch(/\u001b\[38;5;/u)
		setSyntaxHighlight(false)
		const off = await watched(SOURCE, false)
		expect(off.split('\n').find((l) => l.includes('const'))).toBe('  const a = "x" // note')
		setSyntaxHighlight(true)
		const keep = process.env.NO_COLOR
		try {
			process.env.NO_COLOR = '1'
			const none = await watched(SOURCE, false)
			expect(none.split('\n').find((l) => l.includes('const'))).toBe('  const a = "x" // note')
		} finally {
			if (keep === undefined) delete process.env.NO_COLOR
			else process.env.NO_COLOR = keep
		}
	})

	it('colours an indented block under its indentation', async () => {
		await (await import('../../tui/code-highlight.js')).whenGrammarsSettle(['ts'])
		const lines = colourFencedLines(['1. run', '   ```ts', '   const a = 1', '   ```'])
		expect(lines[2]?.startsWith('   ')).toBe(true)
		expect(lines[2]?.replace(ANSI, '')).toBe('   const a = 1')
		expect(lines[1]).toBe('   ```ts')
	})

	it('draws the lines of a row as it did when colour is not asked for', () => {
		const row: TranscriptMessage = { id: 'a', role: 'assistant', content: SOURCE }
		expect(rowLines(row)).toEqual(rowLines(row, { colour: false }))
	})
})
