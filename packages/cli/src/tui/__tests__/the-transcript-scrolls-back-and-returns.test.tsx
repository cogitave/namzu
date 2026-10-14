/**
 * The scrollable transcript: how it opens, what its one hint row says, and how
 * it lets go. Driven by keypresses and rerenders only; nothing here waits on a
 * clock.
 */

import { afterEach, expect, it, vi } from 'vitest'

import { TranscriptScrollView } from '../TranscriptScrollView.js'
import {
	type ScrollState,
	followHint,
	moveScroll,
	openScroll,
	syncScroll,
	transcriptScrollRows,
} from '../transcript-scroll.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const UP = '\x1b[5~'
const DOWN = '\x1b[6~'
const END = '\x1b[F'
const ESC = '\x1b'

function lines(count: number): TranscriptMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `m${i}`,
		role: 'assistant' as const,
		content: `line ${i}`,
	}))
}

/** The bottom of what the view drew: the hint, whatever the terminal height. */
function hintRow(screen: Screen): string {
	return (
		screen
			.viewport()
			.filter((row) => row.trim().length > 0)
			.at(-1) ?? ''
	)
}

let mounted: Screen | null = null
afterEach(async () => {
	vi.useRealTimers()
	await mounted?.unmount()
	mounted = null
})

function view(messages: readonly TranscriptMessage[], onClose: () => void, columns = 60) {
	return (
		<TranscriptScrollView
			messages={messages}
			pending={null}
			height={6}
			columns={columns}
			onClose={onClose}
		/>
	)
}

it('lays messages out with a gutter and a blank row between entries', () => {
	const rows = transcriptScrollRows(lines(2), null, undefined, 40)
	expect(rows.map((row) => [row.glyph, row.text])).toEqual([
		['∴', 'line 0'],
		[' ', ''],
		['∴', 'line 1'],
	])
})

it('picks the longest hint that fits and shortens before it wraps', () => {
	expect(followHint(80, false)).toBe('↓ Back to bottom · esc')
	expect(followHint(20, false)).toBe('↓ Bottom · esc')
	expect(followHint(10, false)).toBe('↓ Bottom')
	expect(followHint(3, false)).toBe('↓')
	expect(followHint(0, false)).toBeNull()
	expect(followHint(80, true)).toBe('New activity · ↓ Back to bottom · esc')
	expect(followHint(32, true)).toBe('New activity · ↓ Bottom · esc')
	expect(followHint(20, true)).toBe('New · ↓ Bottom')
	expect(followHint(9, true)).toBe('↓ Bottom')
	expect(followHint(1, true)).toBe('↓')
})

it('does not open when the whole transcript already fits', () => {
	expect(openScroll(transcriptScrollRows(lines(3), null, undefined, 40), 10)).toBeNull()
})

it('follows again by itself when scrolled to or past the bottom', () => {
	const rows = transcriptScrollRows(lines(30), null, undefined, 40)
	const total = rows.length
	const opened = openScroll(rows, 6) as ScrollState
	expect(opened.top).toBe(total - 6 - 5)
	expect(moveScroll(opened, 'page-up', total, 6)).toMatchObject({ top: opened.top - 5 })
	expect(moveScroll(opened, 'line-down', total, 6)).toMatchObject({ top: opened.top + 1 })
	expect(moveScroll(opened, 'page-down', total, 6)).toBe('latest')
	expect(moveScroll(opened, 'bottom', total, 6)).toBe('latest')
	expect(moveScroll(opened, 'top', total, 6)).toMatchObject({ top: 0 })
})

it('marks new activity once, without moving the window, and not at the bottom', () => {
	const before = transcriptScrollRows(lines(30), null, undefined, 40)
	const opened = openScroll(before, 6) as ScrollState
	expect(syncScroll(opened, before, 6)).toMatchObject({ top: opened.top, unseen: false })
	const after = transcriptScrollRows(lines(31), null, undefined, 40)
	expect(syncScroll(opened, after, 6)).toMatchObject({ top: opened.top, unseen: true })
})

it('opens a page above the end and shows the quiet hint on one row', async () => {
	const screen = await renderToScreen(
		view(lines(30), () => {}),
		{ cols: 60, rows: 12 },
	)
	mounted = screen
	await screen.waitForRender()
	const text = screen.viewport()
	expect(hintRow(screen)).toContain('↓ Back to bottom · esc')
	expect(text.join('\n')).not.toContain('New activity')
	expect(text.join('\n')).not.toContain('line 58')
})

it('pages and scrolls by line, then closes on reaching the bottom', async () => {
	const onClose = vi.fn()
	const screen = await renderToScreen(view(lines(30), onClose), { cols: 60, rows: 12 })
	mounted = screen
	await screen.waitForRender()
	screen.press(UP)
	await screen.waitForRender()
	screen.press('\x1b[A')
	await screen.waitForRender()
	expect(onClose).not.toHaveBeenCalled()
	screen.press('g')
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('line 0')
	screen.press(DOWN)
	await screen.waitForRender()
	expect(onClose).not.toHaveBeenCalled()
	for (let i = 0; i < 20 && onClose.mock.calls.length === 0; i += 1) {
		screen.press(DOWN)
		await screen.waitForRender()
	}
	expect(onClose).toHaveBeenCalledTimes(1)
})

it('shows New activity when output arrives while scrolled up, and End returns', async () => {
	const onClose = vi.fn()
	const screen = await renderToScreen(view(lines(30), onClose), { cols: 60, rows: 12 })
	mounted = screen
	await screen.waitForRender()
	screen.rerender(view(lines(31), onClose))
	await screen.waitForRender()
	expect(hintRow(screen)).toContain('New activity · ↓ Back to bottom · esc')
	screen.press(END)
	await screen.waitForRender()
	expect(onClose).toHaveBeenCalledTimes(1)
})

it('returns to the latest on Esc', async () => {
	const onClose = vi.fn()
	// Ink holds a lone Esc back on a timer until it knows no sequence follows.
	// The clock is faked just for that timer and advanced, not waited out.
	const screen = await renderToScreen(view(lines(30), onClose), { cols: 60, rows: 12 })
	mounted = screen
	await screen.waitForRender()
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	screen.press(ESC)
	vi.advanceTimersByTime(1000)
	vi.useRealTimers()
	await screen.waitForRender()
	expect(onClose).toHaveBeenCalledTimes(1)
})

it('uses the short forms on a narrow terminal', async () => {
	const screen = await renderToScreen(
		view(lines(30), () => {}, 12),
		{ cols: 12, rows: 12 },
	)
	mounted = screen
	await screen.waitForRender()
	expect(hintRow(screen).trim()).toBe('↓ Bottom')
})
