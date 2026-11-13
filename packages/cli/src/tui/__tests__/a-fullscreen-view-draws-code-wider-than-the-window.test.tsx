/**
 * A code block with a line wider than the window is drawn in a small window
 * and stops nothing.
 *
 * The rows of a reply are made while the window renders. Cutting a long code
 * line used to start a second render from there, which left the layout engine
 * holding an update for a node that had been freed: the program stopped with
 * `table index is out of bounds` after a commit, in every fullscreen window
 * narrower than the code. The reply here arrives in small pieces, as a streamed
 * one does, and each piece is a commit.
 */

import { Box, Text } from 'ink'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { FullscreenTranscript } from '../fullscreen/FullscreenTranscript.js'
import { setReducedMotion } from '../motion.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const WIDE = 'async push(item: T): Promise<void> { this.items.push(item); return }'
const REPLY = [
	'Here are the pieces.',
	'',
	'```ts',
	'export interface Shape<T extends object = {}> { kind: "circle" | "square"; size: number }',
	'const sum = a + b // the total',
	WIDE,
	'```',
	'',
	'Closing words.',
].join('\n')

let mounted: Screen | null = null
beforeEach(() => setReducedMotion(true))
afterEach(async () => {
	setReducedMotion(false)
	await mounted?.unmount()
	mounted = null
})

function app(content: string, cols: number, rows: number) {
	const messages: TranscriptMessage[] = [
		{ id: 'u', role: 'user', content: 'go' },
		{ id: 'a', role: 'assistant', content },
	]
	return (
		<Box flexDirection="column" height={rows - 1}>
			<FullscreenTranscript
				messages={messages}
				pending={null}
				columns={cols}
				maxRows={rows - 1}
				keysActive
				homeEndActive
				subscribeWheel={() => () => {}}
				control={{ current: null }}
			/>
			<Text>composer</Text>
		</Box>
	)
}

for (const [cols, rows] of [
	[80, 24],
	[60, 20],
	[40, 12],
] as const) {
	it(`takes a streamed code reply with long lines at ${cols}x${rows}`, async () => {
		const screen = await renderToScreen(app('', cols, rows), {
			cols,
			rows,
			alternateScreen: true,
			incrementalRendering: true,
		})
		mounted = screen
		for (let at = 0; at <= REPLY.length; at += 9) {
			screen.rerender(app(REPLY.slice(0, at), cols, rows))
			await screen.waitForRender()
		}
		screen.rerender(app(REPLY, cols, rows))
		await screen.waitForRender()
		const shown = screen.viewport().join('\n')
		expect(shown).toContain('Closing words.')
		expect(screen.row(-2)).toContain('composer')
	})
}

it('draws the cut rows of a long code line, not an empty row', async () => {
	const screen = await renderToScreen(app(REPLY, 40, 24), {
		cols: 40,
		rows: 24,
		alternateScreen: true,
		incrementalRendering: true,
	})
	mounted = screen
	await screen.waitForRender()
	const shown = screen.viewport().join('\n')
	// The line is cut at a space; both halves are on screen.
	expect(shown).toContain('async push(item: T): Promise<void> {')
	expect(shown).toContain('this.items.push(item); return }')
})
