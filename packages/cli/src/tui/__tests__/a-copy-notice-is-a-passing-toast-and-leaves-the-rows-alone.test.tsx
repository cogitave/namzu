/**
 * Selecting text copies it, and the word that it was copied is a passing note for the status area:
 * the rows of the conversation are exactly as they were, with nothing drawn over the last of them.
 * A view with nowhere to send the note keeps drawing it over its own last row.
 */

import { Box } from 'ink'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { FullscreenTranscript } from '../fullscreen/FullscreenTranscript.js'
import type { CopyReport, FullscreenControl } from '../fullscreen/FullscreenTranscript.js'
import type { PointerReport } from '../fullscreen/mouse-wheel.js'
import { setReducedMotion } from '../motion.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const COLS = 60
const ROWS = 10
let mounted: Screen | null = null
beforeEach(() => setReducedMotion(true))
afterEach(async () => {
	setReducedMotion(false)
	await mounted?.unmount()
	mounted = null
})

const messages: TranscriptMessage[] = [
	{ id: 'u', role: 'user', content: 'first question' },
	{ id: 'a', role: 'assistant', content: 'the answer is here' },
]

async function mount(onNote?: (report: CopyReport) => void) {
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
				copy={async () => ({ text: 'Sent 14 characters to your clipboard.', ok: true })}
				{...(onNote ? { onNote } : {})}
				control={control}
			/>
		</Box>,
		{ cols: COLS, rows: ROWS, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	await screen.waitForRender()
	const row = screen.viewport().findIndex((r) => r.includes('the answer')) + 1
	for (const report of [
		{ kind: 'press', x: 3, y: row },
		{ kind: 'drag', x: 14, y: row },
		{ kind: 'release', x: 14, y: row },
	] as const)
		for (const listener of listeners) listener(report)
	await screen.waitForRender()
	return screen
}

it('hands the note to the owner and leaves every row as it was', async () => {
	const notes: CopyReport[] = []
	const screen = await mount((report) => notes.push(report))
	await vi.waitFor(() => expect(notes).toHaveLength(1))
	expect(notes[0]).toEqual({ text: 'Sent 14 characters to your clipboard.', ok: true })
	expect(screen.viewport().join('\n')).not.toContain('Sent 14 characters')
	expect(screen.viewport().some((row) => row.includes('the answer is here'))).toBe(true)
})

it('draws the note over its own last row only where there is no owner to send it to', async () => {
	const screen = await mount()
	await vi.waitFor(() => expect(screen.viewport().join('\n')).toContain('Sent 14 characters'))
})
