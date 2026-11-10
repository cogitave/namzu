/**
 * The fullscreen transcript draws a window, holds still while it is read, and
 * gives the terminal back.
 *
 * The view is mounted on the alternate screen with the renderer's line diff,
 * as the launcher does, under a one-row stand-in for the composer. Everything
 * is driven by keypresses, wheel calls and resizes, and read off an emulated
 * screen; nothing waits on a clock.
 */

import { Box, Text, useInput } from 'ink'
import { afterEach, expect, it } from 'vitest'

import { FullscreenTranscript } from '../fullscreen/FullscreenTranscript.js'
import type { FullscreenControl } from '../fullscreen/FullscreenTranscript.js'
import type { WheelDirection } from '../fullscreen/mouse-wheel.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PGUP = '\x1b[5~'
const PGDN = '\x1b[6~'

function lines(count: number): TranscriptMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `m${i}`,
		role: 'assistant' as const,
		content: `line ${i}`,
	}))
}

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

function wheelBus() {
	const listeners = new Set<(direction: WheelDirection) => void>()
	return {
		subscribe: (listener: (direction: WheelDirection) => void) => {
			listeners.add(listener)
			return () => void listeners.delete(listener)
		},
		emit: (direction: WheelDirection) => {
			for (const listener of listeners) listener(direction)
		},
	}
}

/** What the real composer does with PgUp: it hands the key to the view. */
function Composer({ control }: { control: { current: FullscreenControl | null } }) {
	useInput((_input, key) => {
		if (key.pageUp) control.current?.scroll('page-up')
	})
	return <Text>composer</Text>
}

function app(
	messages: readonly TranscriptMessage[],
	bus: ReturnType<typeof wheelBus>,
	control: { current: FullscreenControl | null },
	rows: number,
	columns = 40,
) {
	return (
		<Box flexDirection="column" height={rows - 1}>
			<FullscreenTranscript
				messages={messages}
				pending={null}
				columns={columns}
				maxRows={rows - 1}
				keysActive
				homeEndActive
				subscribeWheel={bus.subscribe}
				control={control}
			/>
			<Composer control={control} />
		</Box>
	)
}

async function mount(messages: readonly TranscriptMessage[], rows = 12) {
	const bus = wheelBus()
	const control: { current: FullscreenControl | null } = { current: null }
	const screen = await renderToScreen(app(messages, bus, control, rows), {
		cols: 40,
		rows,
		alternateScreen: true,
		incrementalRendering: true,
	})
	mounted = screen
	return { screen, bus, control, rows }
}

/** The transcript rows on screen: everything above the composer row. */
const shown = (screen: Screen) =>
	screen
		.viewport()
		.filter((row) => /line \d+/.test(row))
		.map((row) => Number(/line (\d+)/.exec(row)?.[1]))

it('takes the alternate screen while mounted and gives the main one back', async () => {
	const { screen } = await mount(lines(5))
	expect(screen.bufferType()).toBe('alternate')
	await screen.unmount()
	mounted = null
	expect(screen.writes().join('')).toContain('\x1b[?1049l')
	expect(screen.bufferType()).toBe('normal')
})

it('draws only the rows that fit above the composer, not the conversation', async () => {
	const { screen } = await mount(lines(500))
	const rows = shown(screen)
	// 500 messages are 999 rows with their separators; the screen has eleven.
	expect(rows.length).toBeLessThan(12)
	expect(rows.at(-1)).toBe(499)
	expect(rows).not.toContain(0)
	expect(screen.row(-2)).toContain('composer')
})

it('keeps its element count to the window however long the conversation is', async () => {
	const short = await mount(lines(40))
	const shortBytes = short.screen.bytesWritten()
	await short.screen.unmount()
	mounted = null
	const long = await mount(lines(4000))
	// One frame of the same window costs the same bytes at ten times the length.
	expect(Math.abs(long.screen.bytesWritten() - shortBytes)).toBeLessThan(shortBytes * 0.2)
})

it('pages back on PgUp, holds still, and returns to the end on PgDn', async () => {
	const { screen } = await mount(lines(60))
	const end = shown(screen)
	screen.press(PGUP)
	await screen.waitForRender()
	const held = shown(screen)
	expect(Math.max(...held)).toBeLessThan(Math.max(...end))
	expect(screen.viewport().join('\n')).toContain('Jump to latest')
	expect(screen.row(-2)).toContain('composer')
	// A page is one row short of the window: the row at the edge stays in view.
	screen.press(PGDN)
	await screen.waitForRender()
	expect(shown(screen).at(-1)).toBe(59)
	expect(screen.viewport().join('\n')).not.toContain('Jump to latest')
})

it('scrolls three rows a wheel notch and holds the place when output arrives', async () => {
	const { screen, bus, control } = await mount(lines(60))
	bus.emit('up')
	await screen.waitForRender()
	const before = shown(screen)
	expect(screen.viewport().join('\n')).toContain('Jump to latest')
	// One more message below the window.
	screen.rerender(app(lines(61), bus, control, 12))
	await screen.waitForRender()
	expect(shown(screen)).toEqual(before)
	expect(screen.viewport().join('\n')).toContain('New activity')
})

it('goes to the top on Home and back on End while the composer is empty', async () => {
	const { screen } = await mount(lines(60))
	screen.press('\x1b[H')
	await screen.waitForRender()
	expect(shown(screen)[0]).toBe(0)
	screen.press('\x1b[F')
	await screen.waitForRender()
	expect(shown(screen).at(-1)).toBe(59)
})

it('returns to the latest when the reader types', async () => {
	const { screen } = await mount(lines(60))
	screen.press(PGUP)
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('Jump to latest')
	screen.press('x')
	await screen.waitForRender()
	expect(shown(screen).at(-1)).toBe(59)
})

it('keeps the line the reader was on when the terminal is resized', async () => {
	const { screen } = await mount(lines(60), 12)
	screen.press(PGUP)
	screen.press(PGUP)
	await screen.waitForRender()
	const bottomBefore = Math.max(...shown(screen))
	await screen.resize(40, 20)
	expect(Math.max(...shown(screen))).toBe(bottomBefore)
	expect(screen.viewport().join('\n')).toContain('Jump to latest')
})

it('is inert while a surface that owns the keys is open', async () => {
	const bus = wheelBus()
	const control: { current: FullscreenControl | null } = { current: null }
	const screen = await renderToScreen(
		<Box flexDirection="column" height={11}>
			<FullscreenTranscript
				messages={lines(60)}
				pending={null}
				columns={40}
				maxRows={11}
				keysActive={false}
				homeEndActive
				subscribeWheel={bus.subscribe}
				control={control}
			/>
		</Box>,
		{ cols: 40, rows: 12, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	screen.press(PGDN)
	screen.press('\x1b[H')
	await screen.waitForRender()
	expect(shown(screen).at(-1)).toBe(59)
})
