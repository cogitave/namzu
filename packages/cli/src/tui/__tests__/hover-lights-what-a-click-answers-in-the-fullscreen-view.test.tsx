/**
 * With any-motion reporting on, a row a click would open is lit while the pointer rests on it, and
 * the screen is redrawn only when the pointer moves onto another target: a sweep inside one row, or
 * over plain text, writes nothing.
 */

import { Box } from 'ink'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Colour on, so a bold underline can be told from none.
vi.hoisted(() => {
	process.env.FORCE_COLOR = '3'
})

import { FullscreenTranscript } from '../fullscreen/FullscreenTranscript.js'
import type { FullscreenControl } from '../fullscreen/FullscreenTranscript.js'
import type { PointerReport } from '../fullscreen/mouse-wheel.js'
import { setReducedMotion } from '../motion.js'
import { EMPTY_GROUP, foldOp, groupText } from '../read-search-group.js'
import { EXPAND_HINT } from '../truncation.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const COLS = 60
const ROWS = 14
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

async function mount() {
	const listeners = new Set<(report: PointerReport) => void>()
	const control: { current: FullscreenControl | null } = { current: null }
	const screen = await renderToScreen(
		<Box flexDirection="column" height={ROWS - 1} paddingRight={1}>
			<FullscreenTranscript
				messages={[reads('t'), { id: 'a', role: 'assistant', content: 'plain words here' }]}
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
			/>
		</Box>,
		{ cols: COLS, rows: ROWS, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	await screen.waitForRender()
	const rowOf = (text: string) => screen.viewport().findIndex((row) => row.includes(text)) + 1
	const move = async (x: number, y: number) => {
		const before = screen.writes().length
		for (const listener of listeners) listener({ kind: 'move', x, y })
		await screen.waitForRender()
		return screen.writes().slice(before).join('')
	}
	return { screen, rowOf, move }
}

it('lights a tool row under the pointer, and only once while the pointer stays on it', async () => {
	const m = await mount()
	const row = m.rowOf('Read 2 files')
	expect(row).toBeGreaterThan(0)
	const lit = await m.move(8, row)
	expect(lit).toContain('\u001b[1m')
	expect(lit).toContain('\u001b[4m')
	// a sweep inside the same row redraws nothing
	expect(await m.move(10, row)).toBe('')
	expect(await m.move(14, row)).toBe('')
})

it('puts the light out on plain text and writes nothing while the pointer moves over it', async () => {
	const m = await mount()
	const row = m.rowOf('Read 2 files')
	const plain = m.rowOf('plain words')
	await m.move(8, row)
	const off = await m.move(8, plain)
	expect(off).not.toBe('')
	expect(await m.move(9, plain)).toBe('')
	expect(await m.move(10, plain)).toBe('')
	expect(await m.move(1, 1)).toBe('')
})
