/**
 * A conversation shorter than the window sits at its top: the header opens the screen, the rows
 * follow it, and the prompt stays pinned at the bottom with the room between. Once the conversation
 * fills the window the rows sit at the bottom again. A click lands on the row it is over in both.
 */

import { Box, Text } from 'ink'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { FullscreenTranscript } from '../fullscreen/FullscreenTranscript.js'
import type { FullscreenControl } from '../fullscreen/FullscreenTranscript.js'
import type { PointerReport } from '../fullscreen/mouse-wheel.js'
import { setReducedMotion } from '../motion.js'
import { EMPTY_GROUP, foldOp, groupText } from '../read-search-group.js'
import { EXPAND_HINT } from '../truncation.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const COLS = 50
const ROWS = 16
let mounted: Screen | null = null
beforeEach(() => setReducedMotion(true))
afterEach(async () => {
	setReducedMotion(false)
	await mounted?.unmount()
	mounted = null
})

function reads(id: string): TranscriptMessage {
	const state = foldOp(foldOp(EMPTY_GROUP, { kind: 'read', key: 'a.ts' }), {
		kind: 'read',
		key: 'b.ts',
	})
	return {
		id,
		role: 'tool',
		content: groupText(state, false),
		glyph: ' ',
		activity: 'exploration',
		group: state,
		meta: EXPAND_HINT,
		detailRef: 1,
		detail: ['Read a.ts', 'alpha text'],
	}
}

async function mount(messages: readonly TranscriptMessage[]) {
	const listeners = new Set<(report: PointerReport) => void>()
	const control: { current: FullscreenControl | null } = { current: null }
	const screen = await renderToScreen(
		<Box flexDirection="column" height={ROWS - 1} paddingRight={1}>
			<FullscreenTranscript
				messages={messages}
				pending={null}
				columns={COLS - 2}
				maxRows={ROWS - 1}
				keysActive
				homeEndActive
				subscribeWheel={() => () => undefined}
				subscribePointer={(listener) => {
					listeners.add(listener)
					return () => void listeners.delete(listener)
				}}
				control={control}
				header={
					<Box flexDirection="column" marginBottom={1}>
						<Text>NAMZU HEADER</Text>
						<Text>/work/folder</Text>
					</Box>
				}
			/>
			<Text>composer box</Text>
		</Box>,
		{ cols: COLS, rows: ROWS, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	await screen.waitForRender()
	return {
		screen,
		rowOf: (text: string) => screen.viewport().findIndex((row) => row.includes(text)) + 1,
		click: async (x: number, y: number) => {
			for (const kind of ['press', 'release'] as const)
				for (const listener of listeners) listener({ kind, x, y })
			await screen.waitForRender()
		},
	}
}

it('draws the header on the first row, then the conversation, with the prompt at the bottom', async () => {
	const m = await mount([{ id: 'u', role: 'user', content: 'hello there' }])
	expect(m.rowOf('NAMZU HEADER')).toBe(1)
	expect(m.rowOf('hello there')).toBeGreaterThan(m.rowOf('/work/folder'))
	expect(m.rowOf('hello there')).toBeLessThan(6)
	// the prompt is the last row of the frame, and the room between is empty
	expect(m.rowOf('composer box')).toBe(ROWS - 1)
	const between = m.screen.viewport().slice(m.rowOf('hello there'), ROWS - 2)
	expect(between.every((row) => row.trim() === '')).toBe(true)
})

it('keeps the newest rows at the bottom once the conversation fills the window', async () => {
	const many = Array.from({ length: 30 }, (_, i) => ({
		id: `m${i}`,
		role: 'system' as const,
		content: `line ${i}`,
	}))
	const m = await mount(many)
	expect(m.rowOf('NAMZU HEADER')).toBe(0)
	expect(m.rowOf('line 29')).toBe(ROWS - 2)
	expect(m.rowOf('composer box')).toBe(ROWS - 1)
})

it('lands a click on the row it is over while the conversation sits at the top', async () => {
	const m = await mount([{ id: 'u', role: 'user', content: 'hello there' }, reads('t')])
	const row = m.rowOf('Read 2 files')
	expect(row).toBeGreaterThan(0)
	expect(m.screen.viewport()[row - 1]).toContain('click to expand')
	await m.click(8, row)
	expect(m.screen.viewport().join('\n')).toContain('alpha text')
})
