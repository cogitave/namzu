/**
 * The reply's mark is a plain round dot in the text colour, not bold, in a
 * two-cell column, on the first text block of a reply only. Later text blocks of
 * the same reply start in the same text column with the mark column blank. A tool
 * row keeps its state-coloured bold dot, so the two never look alike.
 */

import { createRequire } from 'node:module'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import { laterReplyBlocks } from '../reply-mark.js'
import { theme } from '../theme.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})

const paletteOf = (color: string) => `palette:${/\((\d+)\)/.exec(color)?.[1]}`

const screens: Screen[] = []
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
})

let n = 0
const row = (role: TranscriptMessage['role'], content: string, extra = {}): TranscriptMessage => ({
	id: `m${n++}`,
	role,
	content,
	...extra,
})
const said = (text: string) => row('assistant', text)
const call = (text: string) => row('tool', text, { glyph: '●', glyphColor: theme.status.ok })
const result = (text: string) => row('tool', text, { glyph: '⎿' })
const person = (text: string) => row('user', text, { glyph: '›' })
const closing = () => row('system', 'Worked for 8s', { glyph: '✻' })

async function draw(messages: TranscriptMessage[], cols = 100) {
	const screen = await renderToScreen(
		<Transcript messages={messages} pending={null} state="idle" settled={0} resetKey={0} />,
		{ cols, rows: 40 },
	)
	screens.push(screen)
	await screen.waitForRender()
	return screen
}

describe('which text blocks carry the mark', () => {
	it('marks the first text block of a reply and not the later ones', () => {
		const rows = [person('go'), said('first'), call('Bash(x)'), result('ok'), said('second')]
		expect(laterReplyBlocks(rows)).toEqual([false, false, false, false, true])
	})

	it('starts again after the person speaks or the turn closes', () => {
		const rows = [said('a'), said('b'), closing(), said('c'), person('next'), said('d')]
		expect(laterReplyBlocks(rows)).toEqual([false, true, false, false, false, false])
	})

	it('does not count an empty reply or a row with a mark of its own', () => {
		const rows = [said(''), row('assistant', 'own', { glyph: '●' }), said('real')]
		expect(laterReplyBlocks(rows)).toEqual([false, false, false])
	})
})

describe('the reply as drawn', () => {
	it('is a non-bold round dot in the text colour, two cells before the text', async () => {
		const screen = await draw([person('go'), said('Hello there')])
		const at = screen.viewport().findIndex((line) => line.includes('Hello there'))
		expect(at).toBeGreaterThanOrEqual(0)
		const line = screen.row(at)
		expect(line.indexOf('●')).toBe(0)
		expect(line.indexOf('Hello')).toBe(2)
		const dot = screen.cell(at, 0)
		expect(dot.fg).toBe(paletteOf(theme.text.primary))
		expect(dot.bold).toBe(false)
		expect(line).not.toContain('∴')
	})

	it('puts a later text block in the same text column with no mark', async () => {
		const screen = await draw([
			person('go'),
			said('Before the call'),
			call('Bash(echo one)'),
			result('one'),
			said('After the call'),
		])
		const lines = screen.viewport()
		const first = lines.findIndex((l) => l.includes('Before the call'))
		const later = lines.findIndex((l) => l.includes('After the call'))
		expect(lines[first]?.indexOf('Before')).toBe(2)
		expect(lines[later]?.indexOf('After')).toBe(2)
		expect(lines[later]?.slice(0, 2)).toBe('  ')
		expect(lines.filter((l) => l.startsWith('● ') && l.includes('Before')).length).toBe(1)
	})

	it('leaves the tool row its own bold state-coloured dot', async () => {
		const screen = await draw([person('go'), said('Hi'), call('Bash(echo one)')])
		const at = screen.viewport().findIndex((line) => line.includes('Bash(echo one)'))
		const dot = screen.cell(at, screen.row(at).indexOf('●'))
		expect(dot.bold).toBe(true)
		expect(dot.fg).toBe(paletteOf(theme.status.ok))
	})
})
