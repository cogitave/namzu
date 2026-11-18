/**
 * ctrl+o on the fullscreen screen: the whole conversation in the scrolling window, so the wheel
 * scrolls it, a drag selects and copies, a click on a tool row folds it, `/` searches with `n` and
 * `N`, `v` hands it to the editor, each reply carries when and by which model it was written, and
 * the header names the keys. Driven by key presses and pointer reports on an emulated screen.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { DetailedScreen, detailedHeader } from '../fullscreen/DetailedScreen.js'
import type { PointerReport, WheelDirection } from '../fullscreen/mouse-wheel.js'
import { setReducedMotion } from '../motion.js'
import { EMPTY_GROUP, foldOp, groupText } from '../read-search-group.js'
import { EXPAND_HINT } from '../truncation.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const COLS = 100
const ROWS = 20
let mounted: Screen | null = null
let clock = 0

beforeEach(() => {
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

const user = (id: string, content: string): TranscriptMessage => ({ id, role: 'user', content })
const reply = (id: string, content: string, at: number): TranscriptMessage => ({
	id,
	role: 'assistant',
	content,
	at,
	model: 'a-model',
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
		detail: ['Read a.ts', 'alpha text', '', 'Read b.ts', 'beta text'],
	}
}
/** A long conversation: the first prompt is far above the window, and a tool row sits in the middle. */
function conversation(): TranscriptMessage[] {
	const out: TranscriptMessage[] = [user('u0', 'the very first question')]
	for (let i = 0; i < 12; i++) out.push(reply(`a${i}`, `answer number ${i}`, 1_700_000_000_000 + i))
	out.push(reads('t1'))
	out.push(reply('last', 'the final answer', 1_700_000_100_000))
	return out
}

async function mount(messages = conversation(), options: { pointer?: boolean } = {}) {
	const wheel = bus<WheelDirection>()
	const pointers = bus<PointerReport>()
	const copies: string[] = []
	const closed: number[] = []
	const editor: (readonly TranscriptMessage[])[] = []
	const screen = await renderToScreen(
		<DetailedScreen
			messages={messages}
			pending={null}
			columns={COLS - 2}
			maxRows={ROWS - 2}
			dialogWaiting={false}
			subscribeWheel={wheel.subscribe}
			{...(options.pointer === false ? {} : { subscribePointer: pointers.subscribe })}
			copy={async (text) => {
				copies.push(text)
				return { text: 'copied', ok: true }
			}}
			onNote={() => undefined}
			onClose={() => closed.push(1)}
			onOpenInEditor={(all) => editor.push(all)}
		/>,
		{ cols: COLS, rows: ROWS, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	await screen.waitForRender()
	const view = () => screen.viewport().join('\n')
	const rowOf = (text: string) => screen.viewport().findIndex((row) => row.includes(text)) + 1
	const press = async (input: string) => {
		screen.press(input)
		await screen.waitForRender()
	}
	return {
		screen,
		view,
		rowOf,
		press,
		copies,
		closed,
		editor,
		wheel: async (direction: WheelDirection) => {
			wheel.emit(direction)
			await screen.waitForRender()
		},
		pointer: async (report: PointerReport) => {
			pointers.emit(report)
			await screen.waitForRender()
		},
	}
}

it('names its keys in a header', async () => {
	const m = await mount()
	const header = m.screen.viewport()[0] ?? ''
	expect(header).toContain('Detailed transcript')
	for (const key of ['esc', '/ search', 'v editor', 'click a row to fold'])
		expect(header).toContain(key)
	expect(detailedHeader(60, false, true)).not.toContain('click')
	expect(detailedHeader(100, true, true)).toMatch(/^dialog waiting · Detailed transcript/)
	// where no pointer is reported the header does not offer one
	const keyboard = await mount(conversation(), { pointer: false })
	expect(keyboard.screen.viewport()[0]).not.toContain('click')
})

it('scrolls with the wheel and holds the whole conversation, not only the tail', async () => {
	const m = await mount()
	expect(m.view()).toContain('the final answer')
	expect(m.view()).not.toContain('the very first question')
	for (let i = 0; i < 20; i++) await m.wheel('up')
	expect(m.view()).toContain('the very first question')
})

it('draws when and by which model each reply was written', async () => {
	const m = await mount([user('u', 'hi'), reply('a', 'hello there', 1_700_000_000_000)])
	const stamp = m.screen.viewport().find((row) => row.includes('a-model'))
	expect(stamp).toMatch(/\d\d:\d\d · a-model|\d{4}-\d\d-\d\d \d\d:\d\d · a-model/)
	// the person's own message has none
	expect(m.view().match(/a-model/g)).toHaveLength(1)
})

it('opens a tool row whole and folds it on a click, and opens it again on another', async () => {
	const m = await mount()
	expect(m.view()).toContain('alpha text')
	const header = m.rowOf('Read 2 files')
	expect(header).toBeGreaterThan(0)
	expect(m.screen.viewport()[header - 1]).toContain('click to fold')
	const x = (m.screen.viewport()[header - 1]?.indexOf('Read 2 files') ?? 0) + 1
	await m.pointer({ kind: 'press', x, y: header })
	await m.pointer({ kind: 'release', x, y: header })
	expect(m.view()).not.toContain('alpha text')
	const folded = m.rowOf('Read 2 files')
	expect(folded).toBeGreaterThan(0)
	expect(m.screen.viewport()[folded - 1]).toContain('click to expand')
	await m.pointer({ kind: 'press', x: 6, y: folded })
	await m.pointer({ kind: 'release', x: 6, y: folded })
	expect(m.view()).toContain('alpha text')
})

it('selects with a drag and copies it', async () => {
	const m = await mount()
	const row = m.rowOf('the final answer')
	await m.pointer({ kind: 'press', x: 3, y: row })
	await m.pointer({ kind: 'drag', x: 12, y: row })
	await m.pointer({ kind: 'release', x: 12, y: row })
	await vi.waitFor(() => expect(m.copies).toEqual(['the final']))
})

it('searches with / , confirms with enter, then n and N step through the matches', async () => {
	const m = await mount()
	await m.press('/')
	for (const ch of 'answer number') await m.press(ch)
	expect(m.view()).toContain('Find: answer number')
	await m.press('\r')
	// confirmed: the keys are the pager's, and the line says so
	expect(m.view()).toContain('n next')
	const first = m.view().match(/(\d+)\/(\d+)/)
	expect(first?.[2]).toBe('12')
	await m.press('n')
	const second = m.view().match(/(\d+)\/12/)
	expect(second?.[1]).not.toBe(first?.[1])
	await m.press('N')
	expect(m.view().match(/(\d+)\/12/)?.[1]).toBe(first?.[1])
	// a letter is not a query once confirmed, and esc closes the search before the screen
	await m.press('\u001b')
	await vi.waitFor(() => expect(m.view()).not.toContain('Find:'))
	expect(m.closed).toEqual([])
	await m.press('\u001b')
	await vi.waitFor(() => expect(m.closed).toEqual([1]))
})

it('does not read a key as a command while the query is being typed', async () => {
	const m = await mount()
	await m.press('/')
	await m.press('v')
	await m.press('q')
	expect(m.editor).toEqual([])
	expect(m.closed).toEqual([])
	expect(m.view()).toContain('Find: vq')
})

it('hands the conversation to the editor on v, and leaves on q', async () => {
	const m = await mount()
	await m.press('v')
	expect(m.editor).toHaveLength(1)
	expect(m.editor[0]?.[0]?.id).toBe('u0')
	await m.press('q')
	expect(m.closed).toEqual([1])
})

it('scrolls by key without jumping to the end the way typing does on the main screen', async () => {
	const m = await mount()
	await m.press('g')
	expect(m.view()).toContain('the very first question')
	await m.press('j')
	expect(m.view()).not.toContain('the final answer')
	await m.press('G')
	expect(m.view()).toContain('the final answer')
})
