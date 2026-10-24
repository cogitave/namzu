/**
 * Every tool result hangs from one gutter: two columns of indent, the `⎿`,
 * two spaces, then the text. A shell body and a one-line result used to sit
 * in different columns (`   ⎿  output` against ` ⎿ Read…`).
 */

import { afterEach, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import type { ShellOutput } from '../shell-cell.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const screens: Screen[] = []
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
})

const shell: ShellOutput = { stdout: ['hello'], stderr: [], failed: false }

const rows: TranscriptMessage[] = [
	{
		id: 'bash',
		role: 'tool',
		content: 'Bash(echo hello)',
		glyph: '●',
		shell,
		detail: ['hello'],
		detailRef: 1,
	},
	{ id: 'read', role: 'tool', content: 'Read README.md', glyph: '●' },
	{ id: 'result', role: 'tool', content: 'Read 40 lines', glyph: '⎿' },
	{
		id: 'wrapped',
		role: 'tool',
		content: 'A result sentence that is long enough to wrap onto a second line of the screen',
		glyph: '⎿',
	},
]

async function draw(cols: number): Promise<string[]> {
	const screen = await renderToScreen(
		<Transcript messages={rows} pending={null} state="idle" settled={0} resetKey={0} />,
		{ cols, rows: 30 },
	)
	screens.push(screen)
	await screen.waitForRender()
	return screen.scrollback()
}

it('puts a shell body and a one-line result at the same column', async () => {
	const lines = await draw(80)
	const shellLine = lines.find((line) => line.includes('hello') && line.includes('⎿')) ?? ''
	const resultLine = lines.find((line) => line.includes('Read 40 lines')) ?? ''
	expect(shellLine.indexOf('⎿')).toBeGreaterThanOrEqual(0)
	expect(shellLine.indexOf('⎿')).toBe(resultLine.indexOf('⎿'))
	expect(shellLine.indexOf('hello')).toBe(resultLine.indexOf('Read 40 lines'))
	expect(resultLine).toMatch(/^ {2}⎿ {2}Read 40 lines/)
})

it('wraps a long result under its own text, not under the glyph', async () => {
	const lines = await draw(50)
	const first = lines.findIndex((line) => line.includes('A result sentence'))
	expect(first).toBeGreaterThanOrEqual(0)
	const next = lines[first + 1] ?? ''
	expect(next.search(/\S/)).toBe((lines[first] ?? '').indexOf('A result'))
})
