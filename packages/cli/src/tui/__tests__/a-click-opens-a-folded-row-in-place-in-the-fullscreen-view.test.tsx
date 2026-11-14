/**
 * In the fullscreen view with the pointer reported in full, a click on a row
 * that carries the expand hint opens it where it stands, and a click on it
 * again folds it. Driven by pointer reports on an emulated screen; the double
 * click window is a counter standing in for the time.
 */

import { Box, Text } from 'ink'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { FullscreenTranscript } from '../fullscreen/FullscreenTranscript.js'
import type { FullscreenControl } from '../fullscreen/FullscreenTranscript.js'
import type { PointerReport, WheelDirection } from '../fullscreen/mouse-wheel.js'
import { setReducedMotion } from '../motion.js'
import { EMPTY_GROUP, foldOp, groupText } from '../read-search-group.js'
import { EXPAND_HINT } from '../truncation.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const COLS = 44
const ROWS = 14
/** The screen's left padding and the glyph gutter: text starts at screen column 4. */
const TEXT_LEFT = 3

let mounted: Screen | null = null
let clock = 0
beforeEach(() => {
	// A notch moves the view in one frame, so no glide is left running under a click.
	setReducedMotion(true)
	clock = 10_000
	vi.spyOn(Date, 'now').mockImplementation(() => clock)
})
afterEach(async () => {
	setReducedMotion(false)
	vi.restoreAllMocks()
	await mounted?.unmount()
	mounted = null
})

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
		detail: ['Read a.ts', 'alpha text', '', 'Read b.ts', 'beta text'],
	}
}

function output(id: string, lines = 20): TranscriptMessage {
	return {
		id,
		role: 'tool',
		content: 'Bash(seq 20)',
		glyph: '●',
		detailRef: 2,
		detail: Array.from({ length: lines }, (_, i) => `out ${i + 1}`),
	}
}

const note = (id: string, content: string): TranscriptMessage => ({ id, role: 'system', content })
const user = (id: string, content: string): TranscriptMessage => ({ id, role: 'user', content })
/** Enough older rows that the conversation is taller than the window. */
const earlier = (count = 8): TranscriptMessage[] =>
	Array.from({ length: count }, (_, i) => note(`e${i}`, `earlier ${i}`))

interface Options {
	pointer?: boolean
	columns?: number
}

async function mount(messages: readonly TranscriptMessage[], options: Options = {}) {
	const wheel = bus<WheelDirection>()
	const pointers = bus<PointerReport>()
	const control: { current: FullscreenControl | null } = { current: null }
	const copies: string[] = []
	const tree = (list: readonly TranscriptMessage[], columns: number) => (
		<Box flexDirection="column" height={ROWS - 1} paddingLeft={0} paddingRight={1}>
			<FullscreenTranscript
				messages={list}
				pending={null}
				columns={columns - 2}
				maxRows={ROWS - 1}
				keysActive
				homeEndActive
				subscribeWheel={wheel.subscribe}
				{...(options.pointer === false ? {} : { subscribePointer: pointers.subscribe })}
				copy={async (text) => {
					copies.push(text)
					return { text: `Copied ${text.length} characters.`, ok: true }
				}}
				control={control}
			/>
			<Text>composer</Text>
		</Box>
	)
	const screen = await renderToScreen(tree(messages, options.columns ?? COLS), {
		cols: options.columns ?? COLS,
		rows: ROWS,
		alternateScreen: true,
		incrementalRendering: true,
	})
	mounted = screen
	return {
		screen,
		control,
		copies,
		/** A press and a release on one cell, then the frame it caused. */
		click: async (x: number, y: number) => {
			pointers.emit({ kind: 'press', x, y })
			pointers.emit({ kind: 'release', x, y })
			await screen.waitForRender()
		},
		pointer: (kind: PointerReport['kind'], x: number, y: number) => pointers.emit({ kind, x, y }),
		wheelUp: async () => {
			wheel.emit('up')
			await screen.waitForRender()
		},
		resize: async (columns: number) => {
			screen.rerender(tree(messages, columns))
			await screen.waitForRender()
		},
	}
}

/** The 1-based screen row that shows `text`. */
const rowOf = (screen: Screen, text: string): number =>
	screen.viewport().findIndex((row) => row.includes(text)) + 1
const view = (screen: Screen): string => screen.viewport().join('\n')

it('opens a group where it stands and folds it on the next click', async () => {
	const h = await mount([...earlier(), user('u', 'look around'), reads('g'), note('s', 'Done.')])
	expect(view(h.screen)).toContain('Read 2 files · (click to expand)')
	expect(view(h.screen)).not.toContain('ctrl+o')
	const y = rowOf(h.screen, 'Read 2 files')
	await h.click(TEXT_LEFT + 2, y)
	expect(view(h.screen)).toContain('(click to fold)')
	expect(rowOf(h.screen, 'Read 2 files')).toBe(y)
	// The row held its place, so what it opened to runs on below the window.
	expect(view(h.screen)).toContain('Read a.ts')
	h.control.current?.scroll('bottom')
	await h.screen.waitForRender()
	for (const text of ['Read a.ts', 'alpha text', 'Read b.ts', 'beta text'])
		expect(view(h.screen)).toContain(text)
	// A second click on the same cell inside the double-click window is a double click.
	clock += 1_000
	const header = rowOf(h.screen, 'Read 2 files')
	await h.click(TEXT_LEFT + 2, header)
	expect(view(h.screen)).toContain('(click to expand)')
	expect(view(h.screen)).not.toContain('alpha text')
	// At the end the window never shows blank rows under the newest one, so a fold
	// that shortens the conversation brings the row down to it rather than holding it.
	expect(rowOf(h.screen, 'Read 2 files')).toBeGreaterThanOrEqual(header)
	expect(view(h.screen)).toContain('Done.')
})

it('keeps the clicked row on its screen row in a conversation shorter than the window', async () => {
	const h = await mount([user('u', 'look around'), reads('g'), note('s', 'Done.')])
	const y = rowOf(h.screen, 'Read 2 files')
	// Short: the row sits low, with blank rows above it.
	expect(y).toBeGreaterThan(5)
	await h.click(TEXT_LEFT + 2, y)
	expect(rowOf(h.screen, 'Read 2 files')).toBe(y)
	expect(view(h.screen)).toContain('(click to fold)')
	expect(view(h.screen)).toContain('Read a.ts')
	// And it holds when it folds again.
	clock += 1_000
	await h.click(TEXT_LEFT + 2, y)
	expect(rowOf(h.screen, 'Read 2 files')).toBe(y)
	expect(view(h.screen)).toContain('(click to expand)')
})

it('opens a cut output from its hint row and keeps the clicked row on its screen row', async () => {
	const h = await mount([user('u', 'count'), output('t'), note('s', 'Done.')])
	const hint = rowOf(h.screen, '… +')
	expect(view(h.screen)).toContain('(click to expand)')
	await h.click(TEXT_LEFT + 4, hint)
	expect(rowOf(h.screen, '(click to fold)')).toBeGreaterThan(0)
	// The hint row itself went with the fold; the row that stayed is the one clicked, which now shows the output's next line.
	expect(view(h.screen)).toContain('out 6')
	expect(view(h.screen)).not.toContain('to expand')
})

it('stops following when an open row pushes the newest output off, and the way back works', async () => {
	const h = await mount([user('u', 'count'), output('t', 30), note('s', 'Done.')])
	const header = rowOf(h.screen, 'Bash(seq 20)')
	expect(view(h.screen)).toContain('Done.')
	await h.click(TEXT_LEFT + 2, header)
	expect(rowOf(h.screen, 'Bash(seq 20)')).toBe(header)
	expect(view(h.screen)).not.toContain('Done.')
	expect(view(h.screen)).toContain('Jump to latest')
	h.control.current?.scroll('bottom')
	await h.screen.waitForRender()
	expect(view(h.screen)).toContain('Done.')
	expect(view(h.screen)).not.toContain('Jump to latest')
})

it('keeps the row still when the view is scrolled up, and again when it folds', async () => {
	const messages: TranscriptMessage[] = [user('u', 'start')]
	for (let i = 0; i < 8; i++) messages.push(note(`n${i}`, `note ${i}`))
	messages.push(reads('g'))
	for (let i = 8; i < 11; i++) messages.push(note(`n${i}`, `note ${i}`))
	const h = await mount(messages)
	await h.wheelUp()
	const y = rowOf(h.screen, 'Read 2 files')
	expect(y).toBeGreaterThan(0)
	await h.click(TEXT_LEFT + 1, y)
	expect(rowOf(h.screen, 'Read 2 files')).toBe(y)
	expect(view(h.screen)).toContain('alpha text')
	clock += 1_000
	await h.click(TEXT_LEFT + 1, y)
	expect(rowOf(h.screen, 'Read 2 files')).toBe(y)
	expect(view(h.screen)).not.toContain('alpha text')
})

it('does not react to a row without the hint, or to the text an open row opened to', async () => {
	const h = await mount([user('u', 'hello there'), reads('g'), note('s', 'Done.')])
	const before = view(h.screen)
	await h.click(TEXT_LEFT + 1, rowOf(h.screen, 'hello there'))
	clock += 1_000
	await h.click(TEXT_LEFT + 1, rowOf(h.screen, 'Done.'))
	expect(view(h.screen)).toBe(before)
	clock += 1_000
	await h.click(TEXT_LEFT + 1, rowOf(h.screen, 'Read 2 files'))
	const open = view(h.screen)
	clock += 1_000
	await h.click(TEXT_LEFT + 1, rowOf(h.screen, 'alpha text'))
	expect(view(h.screen)).toBe(open)
})

it('lets a click that finds a selection only let go of it', async () => {
	const h = await mount([user('u', 'hello there'), reads('g'), note('s', 'Done.')])
	const hello = rowOf(h.screen, 'hello there')
	h.pointer('press', TEXT_LEFT, hello)
	h.pointer('drag', TEXT_LEFT + 4, hello)
	h.pointer('release', TEXT_LEFT + 4, hello)
	await h.screen.waitForRender()
	expect(h.copies).toEqual(['hello'])
	const y = rowOf(h.screen, 'Read 2 files')
	clock += 1_000
	await h.click(TEXT_LEFT + 1, y)
	expect(view(h.screen)).toContain('(click to expand)')
	expect(view(h.screen)).not.toContain('Read a.ts')
	clock += 1_000
	await h.click(TEXT_LEFT + 1, y)
	expect(view(h.screen)).toContain('Read a.ts')
})

it('does not open on a drag that ends on the cell it began on, nor on a release elsewhere', async () => {
	const h = await mount([user('u', 'hello there'), reads('g'), note('s', 'Done.')])
	const y = rowOf(h.screen, 'Read 2 files')
	h.pointer('press', TEXT_LEFT + 1, y)
	h.pointer('drag', TEXT_LEFT + 5, y)
	h.pointer('drag', TEXT_LEFT + 1, y)
	h.pointer('release', TEXT_LEFT + 1, y)
	await h.screen.waitForRender()
	expect(view(h.screen)).not.toContain('Read a.ts')
	h.pointer('press', TEXT_LEFT + 1, y)
	h.pointer('release', TEXT_LEFT + 3, y)
	await h.screen.waitForRender()
	expect(view(h.screen)).not.toContain('Read a.ts')
})

it('leaves a row open or folded, never between, after a double click', async () => {
	const h = await mount([user('u', 'hello there'), reads('g'), note('s', 'Done.')])
	const folded = view(h.screen)
	const y = rowOf(h.screen, 'Read 2 files')
	const x = TEXT_LEFT + 2
	await h.click(x, y)
	const open = view(h.screen)
	expect(open).not.toBe(folded)
	clock += 100
	await h.click(x, y)
	// The second press of a double click selects a word; it does not toggle again.
	const after = view(h.screen)
	expect(after.includes('Read a.ts')).toBe(true)
	expect(after.includes('(click to fold)')).toBe(true)
	expect(after.includes('(click to expand)')).toBe(false)
})

it('keeps what was open through a resize', async () => {
	const h = await mount([user('u', 'hello there'), reads('g'), note('s', 'Done.')])
	await h.click(TEXT_LEFT + 2, rowOf(h.screen, 'Read 2 files'))
	await h.resize(COLS - 8)
	expect(view(h.screen)).toContain('Read a.ts')
	expect(view(h.screen)).toContain('(click to fold)')
})

it('says ctrl+o and does nothing where the pointer is not reported in full', async () => {
	const h = await mount([user('u', 'hello there'), reads('g'), note('s', 'Done.')], {
		pointer: false,
	})
	expect(view(h.screen)).toContain('Read 2 files · (ctrl+o to expand)')
	expect(view(h.screen)).not.toContain('click')
	const before = view(h.screen)
	await h.click(TEXT_LEFT + 2, rowOf(h.screen, 'Read 2 files'))
	expect(view(h.screen)).toBe(before)
})
