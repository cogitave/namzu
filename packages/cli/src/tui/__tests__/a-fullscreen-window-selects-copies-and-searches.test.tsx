/**
 * The fullscreen window renders Markdown, selects and copies with the pointer,
 * and searches. Driven by pointer reports, keypresses and the control the app
 * uses, and read off an emulated screen; nothing waits on a clock, and the
 * double-click window is driven by a counter standing in for the time.
 */

import { Box, Text } from 'ink'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Colour on: the highlights are styles, and the screen is read for them.
vi.hoisted(() => {
	process.env.FORCE_COLOR = '3'
})

import { FullscreenTranscript } from '../fullscreen/FullscreenTranscript.js'
import type { CopyReport, FullscreenControl } from '../fullscreen/FullscreenTranscript.js'
import type { PointerReport, WheelDirection } from '../fullscreen/mouse-wheel.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const COLS = 40
const ROWS = 12
/** The screen's left padding and the glyph gutter: text starts at screen column 4. */
const TEXT_LEFT = 3

let mounted: Screen | null = null
let clock = 0
beforeEach(() => {
	clock = 10_000
	vi.spyOn(Date, 'now').mockImplementation(() => clock)
})
afterEach(async () => {
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

interface Harness {
	screen: Screen
	pointer: (kind: PointerReport['kind'], x: number, y: number) => void
	copies: string[]
	control: { current: FullscreenControl | null }
	searching: boolean[]
}

function reply(id: string, content: string): TranscriptMessage {
	return { id, role: 'assistant', content }
}

async function mount(
	messages: readonly TranscriptMessage[],
	options: { copyOnSelect?: boolean } = {},
): Promise<Harness & { rerender: (next: readonly TranscriptMessage[]) => Promise<void> }> {
	const wheel = bus<WheelDirection>()
	const pointers = bus<PointerReport>()
	const control: { current: FullscreenControl | null } = { current: null }
	const copies: string[] = []
	const searching: boolean[] = []
	const copy = async (text: string): Promise<CopyReport | null> => {
		copies.push(text)
		return { text: `Copied ${text.length} characters.`, ok: true }
	}
	const tree = (list: readonly TranscriptMessage[]) => (
		<Box flexDirection="column" height={ROWS - 1} paddingLeft={0} paddingRight={1}>
			<FullscreenTranscript
				messages={list}
				pending={null}
				columns={COLS - 2}
				maxRows={ROWS - 1}
				keysActive
				homeEndActive
				subscribeWheel={wheel.subscribe}
				subscribePointer={pointers.subscribe}
				copy={copy}
				copyOnSelect={options.copyOnSelect ?? true}
				onSearchChange={(open) => searching.push(open)}
				control={control}
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
		copies,
		control,
		searching,
		pointer: (kind, x, y) => pointers.emit({ kind, x, y }),
		rerender: async (next) => {
			screen.rerender(tree(next))
			await screen.waitForRender()
		},
	}
}

/** The 0-based viewport row that shows `text`. */
const rowOf = (screen: Screen, text: string): number =>
	screen.viewport().findIndex((row) => row.includes(text))

/** The columns of that row drawn inverted. */
const invertedOn = (screen: Screen, row: number): string =>
	Array.from({ length: COLS }, (_, col) => screen.cell(row, col))
		.filter((cell) => cell.inverse)
		.map((cell) => cell.char)
		.join('')

const REPLY = '# Title\n\n- alpha beta\n- gamma delta\n\n```\nnpm install --save left-pad\n```'

it('draws a reply as Markdown: no marks, a bullet, the code alone', async () => {
	const { screen } = await mount([reply('a', REPLY)])
	const view = screen.viewport().join('\n')
	expect(view).toContain('Title')
	expect(view).not.toContain('# Title')
	expect(view).toContain('• alpha beta')
	expect(view).toContain('npm install --save left-pad')
	expect(view).not.toContain('```')
	expect(screen.cell(rowOf(screen, 'Title'), TEXT_LEFT - 1).bold).toBe(true)
})

it('selects with a drag, shows it inverted and copies the plain text on release', async () => {
	const h = await mount([reply('a', REPLY)])
	const y = rowOf(h.screen, 'alpha beta') + 1
	const start = TEXT_LEFT + 2 // after "• "
	h.pointer('press', start, y)
	h.pointer('drag', start + 4, y)
	await h.screen.waitForRender()
	expect(invertedOn(h.screen, y - 1)).toBe('alpha')
	h.pointer('release', start + 4, y)
	await h.screen.waitForRender()
	expect(h.copies).toEqual(['alpha'])
	expect(h.screen.viewport().join('\n')).toContain('Copied 5 characters.')
})

it('copies across rows with a line break between lines and none inside a wrapped one', async () => {
	const h = await mount([
		reply('a', 'one two three four five six seven eight nine ten eleven\n\nsecond paragraph'),
	])
	const first = rowOf(h.screen, 'one two') + 1
	const last = rowOf(h.screen, 'second paragraph') + 1
	h.pointer('press', TEXT_LEFT, first)
	h.pointer('drag', TEXT_LEFT + 15, last)
	h.pointer('release', TEXT_LEFT + 15, last)
	await h.screen.waitForRender()
	expect(h.copies).toEqual([
		'one two three four five six seven eight nine ten eleven\n\nsecond paragraph',
	])
})

it('selects a word on a double click and a line on a triple click', async () => {
	const h = await mount([reply('a', 'first line here\n\nsecond one')])
	const y = rowOf(h.screen, 'first line') + 1
	const x = TEXT_LEFT + 7 // inside "line"
	h.pointer('press', x, y)
	h.pointer('release', x, y)
	clock += 100
	h.pointer('press', x, y)
	h.pointer('release', x, y)
	await h.screen.waitForRender()
	expect(h.copies).toEqual(['line'])
	expect(invertedOn(h.screen, y - 1)).toBe('line')
	clock += 100
	h.pointer('press', x, y)
	h.pointer('release', x, y)
	await h.screen.waitForRender()
	expect(h.copies.at(-1)).toBe('first line here')
	// A press a while later starts again from a single click.
	clock += 5_000
	h.pointer('press', x, y)
	h.pointer('release', x, y)
	expect(h.copies).toHaveLength(2)
})

it('tells what was copied without moving a single row', async () => {
	const h = await mount([reply('a', 'some text here'), reply('b', 'middle'), reply('c', 'tail')])
	const before = h.screen.viewport()
	const y = rowOf(h.screen, 'some text') + 1
	h.pointer('press', TEXT_LEFT, y)
	h.pointer('drag', TEXT_LEFT + 3, y)
	h.pointer('release', TEXT_LEFT + 3, y)
	await h.screen.waitForRender()
	const after = h.screen.viewport()
	expect(after.join('\n')).toContain('Copied 4 characters.')
	// Only the last row of the window gives way to the note; every other row stays.
	const last = after.findIndex((row) => row.includes('Copied'))
	expect(after.filter((_, i) => i !== last)).toEqual(before.filter((_, i) => i !== last))
	expect(rowOf(h.screen, 'some text')).toBe(y - 1)
})

it('does nothing for a click that did not move', async () => {
	const h = await mount([reply('a', 'some text here')])
	const y = rowOf(h.screen, 'some text') + 1
	h.pointer('press', TEXT_LEFT + 2, y)
	h.pointer('release', TEXT_LEFT + 2, y)
	await h.screen.waitForRender()
	expect(h.copies).toEqual([])
	expect(invertedOn(h.screen, y - 1)).toBe('')
})

it('ignores a press on the composer row', async () => {
	const h = await mount([reply('a', 'some text here')])
	h.pointer('press', TEXT_LEFT, ROWS)
	h.pointer('drag', TEXT_LEFT + 5, ROWS)
	h.pointer('release', TEXT_LEFT + 5, ROWS)
	expect(h.copies).toEqual([])
})

it('selects wide characters whole and copies them', async () => {
	const h = await mount([reply('a', '漢字漢字 and 🎉 end')])
	const y = rowOf(h.screen, '漢字') + 1
	h.pointer('press', TEXT_LEFT + 1, y)
	h.pointer('drag', TEXT_LEFT + 2, y)
	h.pointer('release', TEXT_LEFT + 2, y)
	await h.screen.waitForRender()
	// Cells 1 and 2 are the second half of the first character and the first of the second.
	expect(h.copies).toEqual(['漢字'])
})

it('lets go of the selection on Escape, and the copy stays where it was put', async () => {
	const h = await mount([reply('a', 'some text here'), reply('b', 'tail')])
	const y = rowOf(h.screen, 'some text') + 1
	h.pointer('press', TEXT_LEFT, y)
	h.pointer('drag', TEXT_LEFT + 3, y)
	h.pointer('release', TEXT_LEFT + 3, y)
	await h.screen.waitForRender()
	expect(invertedOn(h.screen, y - 1)).toBe('some')
	// Already copied, the highlight goes but the Esc stays the owner's, so it
	// can still interrupt a running turn.
	expect(h.control.current?.takeEscape()).toBe(false)
	await h.screen.waitForRender()
	expect(invertedOn(h.screen, y - 1)).toBe('')
	expect(h.control.current?.takeEscape()).toBe(false)
	expect(h.copies).toEqual(['some'])
})

it('takes the Escape that lets go of a selection that was not copied', async () => {
	const h = await mount([reply('a', 'some text here'), reply('b', 'tail')], {
		copyOnSelect: false,
	})
	const y = rowOf(h.screen, 'some text') + 1
	h.pointer('press', TEXT_LEFT, y)
	h.pointer('drag', TEXT_LEFT + 3, y)
	h.pointer('release', TEXT_LEFT + 3, y)
	await h.screen.waitForRender()
	expect(h.control.current?.takeEscape()).toBe(true)
	await h.screen.waitForRender()
	expect(invertedOn(h.screen, y - 1)).toBe('')
	expect(h.copies).toEqual([])
})

it('keeps the selection on its text while output arrives below it', async () => {
	const messages = [reply('a', 'keep this words'), reply('b', 'next')]
	const h = await mount(messages)
	const y = rowOf(h.screen, 'keep this') + 1
	h.pointer('press', TEXT_LEFT, y)
	h.pointer('drag', TEXT_LEFT + 3, y)
	h.pointer('release', TEXT_LEFT + 3, y)
	await h.screen.waitForRender()
	await h.rerender([...messages, reply('c', 'more\n\nand more\n\nand more again')])
	const now = rowOf(h.screen, 'keep this')
	expect(now).toBeGreaterThanOrEqual(0)
	expect(now).toBeLessThan(y - 1)
	expect(invertedOn(h.screen, now)).toBe('keep')
})

it('leaves the copy to the key when selections are not copied on release', async () => {
	const h = await mount([reply('a', 'some text here')], { copyOnSelect: false })
	const y = rowOf(h.screen, 'some text') + 1
	h.pointer('press', TEXT_LEFT, y)
	h.pointer('drag', TEXT_LEFT + 3, y)
	h.pointer('release', TEXT_LEFT + 3, y)
	await h.screen.waitForRender()
	expect(h.copies).toEqual([])
	expect(h.screen.viewport().join('\n')).toContain('Selected.')
	expect(h.control.current?.takeCopy()).toBe(true)
	expect(h.copies).toEqual(['some'])
})

function numbered(): TranscriptMessage[] {
	return Array.from({ length: 40 }, (_, i) =>
		reply(
			`m${i}`,
			i === 7 ? 'the needle is here' : i === 20 ? 'another Needle there' : `filler ${i}`,
		),
	)
}

it('opens a search line, finds matches as it is typed and jumps to the first', async () => {
	const h = await mount(numbered())
	h.screen.press('\x1bs')
	await h.screen.waitForRender()
	expect(h.searching).toEqual([true])
	expect(h.screen.row(-3)).toContain('Find:')
	for (const ch of 'needle') h.screen.press(ch)
	await h.screen.waitForRender()
	const line = h.screen.row(-3)
	expect(line).toContain('Find: needle')
	expect(line).toContain('2/2')
	// Nearest at or above the bottom: the later one, scrolled to.
	expect(rowOf(h.screen, 'Needle there')).toBeGreaterThanOrEqual(0)
	expect(invertedOn(h.screen, rowOf(h.screen, 'Needle there'))).toBe('Needle')
})

it('steps to the next and previous match, wrapping, and scrolls to it', async () => {
	const h = await mount(numbered())
	h.screen.press('\x1bs')
	for (const ch of 'needle') h.screen.press(ch)
	await h.screen.waitForRender()
	h.screen.press('\x1b[13;2u') // Shift+Enter
	await h.screen.waitForRender()
	expect(h.screen.row(-3)).toContain('1/2')
	expect(rowOf(h.screen, 'the needle is here')).toBeGreaterThanOrEqual(0)
	expect(invertedOn(h.screen, rowOf(h.screen, 'the needle is here'))).toBe('needle')
	h.screen.press('\r')
	await h.screen.waitForRender()
	expect(h.screen.row(-3)).toContain('2/2')
	expect(rowOf(h.screen, 'Needle there')).toBeGreaterThanOrEqual(0)
	h.screen.press('\r')
	await h.screen.waitForRender()
	expect(h.screen.row(-3)).toContain('1/2')
})

it('says when nothing matches and erases with backspace', async () => {
	const h = await mount(numbered())
	h.screen.press('\x1bs')
	for (const ch of 'zzz') h.screen.press(ch)
	await h.screen.waitForRender()
	expect(h.screen.row(-3)).toContain('No matches')
	h.screen.press('\x7f')
	h.screen.press('\x7f')
	h.screen.press('\x7f')
	await h.screen.waitForRender()
	expect(h.screen.row(-3)).toContain('Find: ▏')
})

it('returns to the latest on Escape when the reader was following', async () => {
	const h = await mount(numbered())
	h.screen.press('\x1bs')
	for (const ch of 'needle') h.screen.press(ch)
	await h.screen.waitForRender()
	h.screen.press('\x1b[13;2u')
	await h.screen.waitForRender()
	expect(rowOf(h.screen, 'filler 39')).toBe(-1)
	expect(h.control.current?.takeEscape()).toBe(true)
	await h.screen.waitForRender()
	expect(h.searching).toEqual([true, false])
	expect(rowOf(h.screen, 'filler 39')).toBeGreaterThanOrEqual(0)
	expect(h.screen.viewport().join('\n')).not.toContain('Find:')
})

it('returns to where the reader was when they had scrolled up', async () => {
	const h = await mount(numbered())
	h.screen.press('\x1b[5~')
	await h.screen.waitForRender()
	const before = h.screen.viewport().filter((row) => /filler \d+/.test(row))
	h.screen.press('\x1bs')
	for (const ch of 'needle') h.screen.press(ch)
	await h.screen.waitForRender()
	h.screen.press('\x1b[13;2u')
	await h.screen.waitForRender()
	expect(h.control.current?.takeEscape()).toBe(true)
	await h.screen.waitForRender()
	expect(h.screen.viewport().filter((row) => /filler \d+/.test(row))).toEqual(before)
})
