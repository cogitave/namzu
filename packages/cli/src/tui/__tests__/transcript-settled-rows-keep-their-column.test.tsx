/**
 * A row keeps its column, and its wrap, when it settles.
 *
 * Ink lays `<Static>` out as an absolutely positioned node as wide as the
 * terminal, so the one column of padding App gives every row reached the
 * live rows and never the settled ones: a finished screen mixed rows at
 * column 0 and column 1, and a settled row wrapped two columns wider than it
 * had live. The settled rows now carry that padding on both sides.
 */

import { Box } from 'ink'
import { afterEach, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

function row(id: string, content: string, glyph: string): TranscriptMessage {
	return { id, role: 'tool', content, glyph }
}

it.each([40, 100])('draws a settled row in the column and at the width it had live, at %i columns', async (cols) => {
	const long = Array.from({ length: 40 }, (_, i) => `sözcük${i}`).join(' ')
	const messages = [row('settled', long, '✓'), row('live', long, '✓')]
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			<Transcript messages={messages} pending={null} state="idle" settled={1} resetKey={0} staticIndent={1} />
		</Box>,
		{ cols, rows: 40 },
	)
	const rows = mounted.viewport().filter((line) => line.trim().length > 0)
	const half = rows.length / 2
	const settled = rows.slice(0, half)
	const live = rows.slice(half)
	// Same rows, same wrap, same column: the settled copy is indistinguishable.
	expect(settled).toEqual(live)
	expect(settled[0]).toMatch(/^ ✓ sözcük0 /u)
	// And nothing reaches the last column, where a terminal would wrap it again.
	for (const line of rows) expect([...line].length).toBeLessThanOrEqual(cols - 1)
})

it.each([40, 80, 120, 160])(
	'starts every wrapped row of a notice in the column of its first word, at %i columns',
	async (cols) => {
		// Words sized so that some end exactly at the edge: Ink's own wrap put
		// the following space at the start of the next row.
		const words = Array.from({ length: 60 }, (_, i) => 'ğ'.repeat((i % 7) + 2)).join(' ')
		const messages: TranscriptMessage[] = [
			{ id: 'n', role: 'system', content: words, glyph: '·' },
			{ id: 'u', role: 'user', content: words },
		]
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<Transcript messages={messages} pending={null} state="idle" settled={1} resetKey={0} staticIndent={1} />
			</Box>,
			{ cols, rows: 60 },
		)
		const rows = mounted.viewport().filter((line) => line.trim().length > 0)
		for (const line of rows) {
			expect(line).toMatch(/^ (?:[·›] |  )\S/u)
			expect([...line].length).toBeLessThanOrEqual(cols - 1)
		}
	},
)
