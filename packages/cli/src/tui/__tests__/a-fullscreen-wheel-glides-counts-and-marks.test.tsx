/**
 * The wheel in the fullscreen view adds up, glides and speeds up; the hint
 * counts the replies that came while the reader was away and can be clicked;
 * and a quiet rule marks where the new part begins.
 *
 * The wheel's clock is the test's own: a notch carries the time it arrived at,
 * and each frame of a glide runs when the test says so, so nothing waits on how
 * fast the machine is.
 */

import { Box, Text } from 'ink'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { FullscreenTranscript } from '../fullscreen/FullscreenTranscript.js'
import type { FullscreenControl, WheelClock } from '../fullscreen/FullscreenTranscript.js'
import { WHEEL_FEEL } from '../fullscreen/glide.js'
import type { PointerReport, WheelDirection } from '../fullscreen/mouse-wheel.js'
import { setReducedMotion } from '../motion.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const COLS = 40

const reply = (i: number, text = `line ${i}`): TranscriptMessage => ({
	id: `m${i}`,
	role: 'assistant',
	content: text,
})
const lines = (count: number) => Array.from({ length: count }, (_, i) => reply(i))
const tool = (i: number): TranscriptMessage => ({ id: `t${i}`, role: 'tool', content: `ran ${i}` })
const user = (i: number): TranscriptMessage => ({ id: `u${i}`, role: 'user', content: `ask ${i}` })

/** A clock the test winds by hand. */
function manualClock() {
	let at = 1_000
	let next: (() => void) | null = null
	const clock: WheelClock = {
		now: () => at,
		after: (run) => {
			next = run
			return () => {
				if (next === run) next = null
			}
		},
	}
	return {
		clock,
		wait: (ms: number) => {
			at += ms
		},
		/** Run the frame that is waiting; false when none is. */
		frame: () => {
			const run = next
			next = null
			run?.()
			return run !== null
		},
		pending: () => next !== null,
	}
}

function bus<T>() {
	const listeners = new Set<(value: T) => void>()
	return {
		subscribe: (listener: (value: T) => void) => {
			listeners.add(listener)
			return () => void listeners.delete(listener)
		},
		emit: (value: T) => {
			for (const listener of listeners) listener(value)
		},
	}
}

interface Options {
	readonly wheelRows?: number
	readonly wheelAccel?: boolean
	readonly pointer?: boolean
	readonly rows?: number
}

let mounted: Screen | null = null
beforeEach(() => setReducedMotion(false))
afterEach(async () => {
	setReducedMotion(false)
	await mounted?.unmount()
	mounted = null
})

async function mount(messages: readonly TranscriptMessage[], options: Options = {}) {
	const ROWS = options.rows ?? 12
	const wheel = bus<WheelDirection>()
	const pointers = bus<PointerReport>()
	const control: { current: FullscreenControl | null } = { current: null }
	const time = manualClock()
	const tree = (list: readonly TranscriptMessage[], pending: TranscriptMessage | null = null) => (
		<Box flexDirection="column" height={ROWS - 1}>
			<FullscreenTranscript
				messages={list}
				pending={pending}
				columns={COLS}
				maxRows={ROWS - 1}
				keysActive
				homeEndActive
				subscribeWheel={wheel.subscribe}
				{...(options.pointer ? { subscribePointer: pointers.subscribe } : {})}
				control={control}
				clock={time.clock}
				{...(options.wheelRows !== undefined ? { wheelRows: options.wheelRows } : {})}
				{...(options.wheelAccel !== undefined ? { wheelAccel: options.wheelAccel } : {})}
			/>
			<Text>composer</Text>
		</Box>
	)
	const screen = await renderToScreen(tree(messages), {
		cols: COLS,
		rows: ROWS,
		alternateScreen: true,
		incrementalRendering: true,
	})
	mounted = screen
	return {
		screen,
		time,
		control,
		rerender: async (
			list: readonly TranscriptMessage[],
			pending: TranscriptMessage | null = null,
		) => {
			screen.rerender(tree(list, pending))
			await screen.waitForRender()
		},
		notch: (direction: WheelDirection) => wheel.emit(direction),
		click: async (x: number, y: number) => {
			pointers.emit({ kind: 'press', x, y })
			pointers.emit({ kind: 'release', x, y })
			await screen.waitForRender()
		},
		/** Run every frame of the glide, painting each one. Returns how many ran. */
		settle: async () => {
			let frames = 0
			while (time.frame()) {
				frames++
				await screen.waitForRender()
			}
			return frames
		},
	}
}

/** The message numbers on screen. */
const shown = (screen: Screen) =>
	screen
		.viewport()
		.filter((row) => /line \d+/.test(row))
		.map((row) => Number(/line (\d+)/.exec(row)?.[1]))
const text = (screen: Screen) => screen.viewport().join('\n')
/** The hint is the last row of the transcript, above the composer row. */
const hintRow = (screen: Screen) => screen.row(-3)

it('adds two notches that arrive in one input chunk', async () => {
	const h = await mount(lines(60))
	h.notch('up')
	h.notch('up')
	await h.screen.waitForRender()
	await h.settle()
	// Six rows are three messages: the view was at line 59 and is now at line 56.
	expect(Math.max(...shown(h.screen))).toBe(56)
})

it('moves a slow notch exactly three rows, in a short glide that lands on them', async () => {
	const h = await mount(lines(60))
	h.notch('up')
	await h.screen.waitForRender()
	// The first frame is at once: scrolling up has left the end already.
	expect(text(h.screen)).toContain('Jump to latest')
	const first = Math.max(...shown(h.screen))
	expect(first).toBeLessThanOrEqual(59)
	const frames = await h.settle()
	expect(frames).toBeGreaterThanOrEqual(1)
	expect(frames).toBeLessThanOrEqual(3)
	// Three rows up from line 59's row is line 58's gap: line 57 is the last text.
	expect(Math.max(...shown(h.screen))).toBe(57)
})

it('speeds up on a fast run and covers far more than plain steps', async () => {
	const h = await mount(lines(300), { rows: 30 })
	for (let i = 0; i < 10; i++) {
		h.notch('up')
		h.time.wait(50)
	}
	await h.screen.waitForRender()
	await h.settle()
	const plain = 10 * WHEEL_FEEL.rows
	const moved = (299 - Math.max(...shown(h.screen))) * 2
	expect(moved).toBeGreaterThan(plain * 2)
})

it('is a plain step for every notch with the speed-up off, however fast', async () => {
	const h = await mount(lines(300), { wheelAccel: false })
	for (let i = 0; i < 10; i++) {
		h.notch('up')
		h.time.wait(50)
	}
	await h.screen.waitForRender()
	await h.settle()
	expect(Math.max(...shown(h.screen))).toBe(299 - 15)
})

it('moves the rows the setting asks for', async () => {
	const h = await mount(lines(60), { wheelRows: 8 })
	h.notch('up')
	await h.screen.waitForRender()
	await h.settle()
	expect(Math.max(...shown(h.screen))).toBe(55)
})

it('has no glide under reduced motion: a notch is one frame', async () => {
	setReducedMotion(true)
	const h = await mount(lines(60))
	h.notch('up')
	h.notch('up')
	await h.screen.waitForRender()
	expect(h.time.pending()).toBe(false)
	expect(Math.max(...shown(h.screen))).toBe(56)
})

it('stops following at the first notch and follows again on reaching the bottom', async () => {
	const h = await mount(lines(60))
	h.notch('up')
	await h.screen.waitForRender()
	expect(text(h.screen)).toContain('Jump to latest')
	await h.settle()
	h.time.wait(1_000)
	h.notch('down')
	await h.screen.waitForRender()
	await h.settle()
	expect(Math.max(...shown(h.screen))).toBe(59)
	expect(text(h.screen)).not.toContain('Jump to latest')
})

it('cuts a glide short on a change of direction and on a key', async () => {
	const h = await mount(lines(300))
	for (let i = 0; i < 6; i++) {
		h.notch('up')
		h.time.wait(50)
	}
	await h.screen.waitForRender()
	h.control.current?.scroll('bottom')
	await h.screen.waitForRender()
	expect(h.time.frame()).toBe(false)
	expect(Math.max(...shown(h.screen))).toBe(299)
})

it('holds what is on screen when output arrives in the middle of a glide', async () => {
	const h = await mount(lines(300))
	for (let i = 0; i < 8; i++) {
		h.notch('up')
		h.time.wait(50)
	}
	await h.screen.waitForRender()
	h.time.frame()
	await h.screen.waitForRender()
	const before = shown(h.screen)
	await h.rerender([...lines(300), reply(300), reply(301)])
	expect(shown(h.screen)).toEqual(before)
	await h.settle()
	expect(Math.max(...shown(h.screen))).toBeLessThan(Math.max(...before))
})

it('counts the replies that came while the reader was away', async () => {
	const h = await mount(lines(60))
	h.notch('up')
	await h.screen.waitForRender()
	await h.settle()
	expect(hintRow(h.screen)).toContain('↓ Jump to latest · End')
	await h.rerender([...lines(60), reply(60)])
	expect(hintRow(h.screen)).toContain('1 new reply · ↓ Jump to latest · End')
	// Tool calls between replies are not replies.
	await h.rerender([...lines(60), reply(60), tool(1), tool(2), reply(61), tool(3), reply(62)])
	expect(hintRow(h.screen)).toContain('3 new replies')
})

it('says only that something happened when the news is not a reply', async () => {
	const h = await mount(lines(60))
	h.notch('up')
	await h.screen.waitForRender()
	await h.settle()
	await h.rerender([...lines(60), tool(1)])
	expect(hintRow(h.screen)).toContain('New activity')
})

it('says the reply is growing when the one that was being written got longer', async () => {
	const h = await mount(lines(59), {})
	const writing = { ...reply(59, 'one'), pending: true }
	await h.rerender(lines(59), writing)
	h.notch('up')
	await h.screen.waitForRender()
	await h.settle()
	await h.rerender(lines(59), { ...writing, content: 'one two three four' })
	expect(hintRow(h.screen)).toContain('Reply still growing')
	expect(hintRow(h.screen)).not.toContain('new repl')
})

it('puts one quiet rule above the first unseen reply, which stays after the jump down', async () => {
	const h = await mount(lines(60))
	h.notch('up')
	await h.screen.waitForRender()
	await h.settle()
	await h.rerender([...lines(60), reply(60), reply(61)])
	// Jump to the bottom: the rule is above the new replies, two screens' worth of them.
	h.control.current?.scroll('bottom')
	await h.screen.waitForRender()
	expect(text(h.screen)).not.toContain('Jump to latest')
	const found = h.screen.viewport().findIndex((row) => row.includes('2 new replies'))
	expect(found).toBeGreaterThanOrEqual(0)
	expect(h.screen.viewport()[found + 2]).toContain('line 60')
	// It stays until the person sends the next message.
	await h.rerender([...lines(60), reply(60), reply(61), user(1)])
	expect(text(h.screen)).not.toContain('2 new replies')
})

it('does not move what the view is anchored to when the rule appears', async () => {
	const h = await mount(lines(60))
	h.notch('up')
	await h.screen.waitForRender()
	await h.settle()
	const before = shown(h.screen)
	await h.rerender([...lines(60), reply(60)])
	expect(shown(h.screen)).toEqual(before)
})

it('jumps to the newest row and follows again on a click on the hint', async () => {
	const h = await mount(lines(60), { pointer: true })
	h.notch('up')
	await h.screen.waitForRender()
	await h.settle()
	await h.rerender([...lines(60), reply(60)])
	// The hint is screen row 10, counted from 1: the composer is on row 11.
	await h.click(10, 10)
	expect(text(h.screen)).not.toContain('Jump to latest')
	expect(Math.max(...shown(h.screen))).toBe(60)
})

it('leaves the view alone for a click on any other row', async () => {
	const h = await mount(lines(60), { pointer: true })
	h.notch('up')
	await h.screen.waitForRender()
	await h.settle()
	const before = shown(h.screen)
	await h.click(10, 3)
	expect(shown(h.screen)).toEqual(before)
	expect(text(h.screen)).toContain('Jump to latest')
})
