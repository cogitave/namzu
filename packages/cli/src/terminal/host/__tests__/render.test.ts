import headlessPackage from '@xterm/headless'
import type { Terminal as TerminalType } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { HeadlessScreen } from '../../screen.js'
import { ATTR_BOLD, ATTR_INVERSE, BLANK_CELL, rgb, sgr } from '../cell.js'
import { Frame } from '../frame.js'
import { DiffWriter } from '../writer.js'

const { Terminal } = headlessPackage as unknown as { Terminal: typeof TerminalType }

async function screen(cols: number, rows: number, data: string): Promise<HeadlessScreen> {
	const s = new HeadlessScreen(cols, rows, 100)
	s.write(data)
	await s.settled()
	return s
}

/** Replays writer output into a fresh emulator: what a real terminal would end up showing. */
async function replay(cols: number, rows: number, ...chunks: string[]): Promise<HeadlessScreen> {
	const s = new HeadlessScreen(cols, rows, 0)
	for (const c of chunks) s.write(c)
	await s.settled()
	return s
}

function cellsOf(s: HeadlessScreen) {
	const src = s.cells()
	const out = []
	for (let y = 0; y < src.rows; y++) for (let x = 0; x < src.cols; x++) out.push(src.cell(x, y))
	return out
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences
const ESC_SEQUENCE = /\x1b\[[0-9;?]*[a-zA-Z]/g

const COLORFUL =
	'\x1b[1;31mred bold\x1b[0m \x1b[38;5;208morange\x1b[0m \x1b[48;2;10;20;30;38;2;200;100;50mtrue\x1b[0m\r\n' +
	'\x1b[7minverse\x1b[0m \x1b[4munder\x1b[0m \x1b[3;9mital-strike\x1b[0m\r\n' +
	'中文 wide \u{1F600} é\r\nplain'

describe('reading cells from the emulator', () => {
	it('keeps colours and attributes', async () => {
		const s = await screen(40, 6, COLORFUL)
		const src = s.cells()
		expect(src.cell(0, 0)).toMatchObject({ ch: 'r', fg: 1, attrs: ATTR_BOLD })
		expect(src.cell(8, 0)).toBe(BLANK_CELL)
		expect(src.cell(9, 0)).toMatchObject({ ch: 'o', fg: 208 })
		expect(src.cell(16, 0)).toMatchObject({ ch: 't', fg: rgb(200, 100, 50), bg: rgb(10, 20, 30) })
		expect(src.cell(0, 1)?.attrs).toBe(ATTR_INVERSE)
	})

	it('reads wide characters as a width-2 cell and an empty second half', async () => {
		const s = await screen(40, 6, COLORFUL)
		const src = s.cells()
		expect(src.cell(0, 2)).toMatchObject({ ch: '中', width: 2 })
		expect(src.cell(1, 2)).toMatchObject({ ch: '', width: 0 })
		expect(src.cell(2, 2)).toMatchObject({ ch: '文', width: 2 })
		expect(src.cell(-1, 0)).toBeUndefined()
		expect(src.cell(40, 0)).toBeUndefined()
	})

	it('reports the cursor and its visibility', async () => {
		const s = await screen(20, 4, 'ab\x1b[?25l')
		expect(s.cells().cursor).toEqual({ x: 2, y: 0, visible: false })
		s.write('\x1b[?25h')
		await s.settled()
		expect(s.cells().cursor.visible).toBe(true)
	})

	it('reads the alternate screen while a program is on it, and the main one after', async () => {
		const s = await screen(20, 4, 'main\x1b[?1049h\x1b[Halt')
		expect(s.cells().cell(0, 0)?.ch).toBe('a')
		s.write('\x1b[?1049l')
		await s.settled()
		expect(s.cells().cell(0, 0)?.ch).toBe('m')
	})

	it('reads rows scrolled back into the history and hides the cursor there', async () => {
		const s = await screen(10, 3, 'one\r\ntwo\r\nthree\r\nfour\r\nfive')
		expect(s.cells().cell(0, 0)?.ch).toBe('t')
		const back = s.cells(2)
		expect(back.cell(0, 0)?.ch).toBe('o')
		expect(back.cursor.visible).toBe(false)
		expect(s.cells(999).cell(0, 0)?.ch).toBe('o')
	})

	it('does not alias the emulator cell it reads from', async () => {
		const s = await screen(5, 1, 'ab')
		const src = s.cells()
		const first = src.cell(0, 0)
		const second = src.cell(1, 0)
		expect(first?.ch).toBe('a')
		expect(second?.ch).toBe('b')
	})
})

describe('frame', () => {
	it('blits a source into a rectangle and clips it', async () => {
		const s = await screen(10, 3, 'abcdef\r\nghijkl')
		const f = new Frame(12, 5)
		f.blit(s.cells(), { x: 4, y: 1, width: 4, height: 1 })
		expect(f.cellAt(4, 1)?.ch).toBe('a')
		expect(f.cellAt(7, 1)?.ch).toBe('d')
		expect(f.cellAt(8, 1)).toBe(BLANK_CELL)
		expect(f.cellAt(4, 2)).toBe(BLANK_CELL)
	})

	it('blanks a wide character cut by the right edge of its rectangle', async () => {
		const s = await screen(10, 1, 'a中文')
		const f = new Frame(10, 1)
		f.blit(s.cells(), { x: 0, y: 0, width: 4, height: 1 })
		expect(f.cellAt(1, 0)?.ch).toBe('中')
		expect(f.cellAt(3, 0)).toBe(BLANK_CELL)
	})

	it('places the cursor in frame coordinates and drops it when outside the rectangle', async () => {
		const s = await screen(10, 3, 'abc')
		const f = new Frame(20, 5)
		f.blit(s.cells(), { x: 6, y: 1, width: 8, height: 3 })
		expect(f.cursor).toEqual({ x: 9, y: 1, visible: true })
		f.blit(s.cells(), { x: 6, y: 1, width: 2, height: 3 })
		expect(f.cursor.visible).toBe(false)
	})

	it('writes sidebar text clipped to its rectangle with a style', () => {
		const f = new Frame(20, 3)
		const rect = { x: 0, y: 0, width: 6, height: 3 }
		f.fillRect(rect, { bg: 4 })
		expect(f.writeText(rect, 1, 'abcdefgh', { fg: 2 })).toBe(6)
		expect(f.cellAt(5, 1)).toMatchObject({ ch: 'f', fg: 2, bg: -1 })
		expect(f.cellAt(6, 1)).toBe(BLANK_CELL)
		expect(f.cellAt(0, 0)?.bg).toBe(4)
		expect(f.writeText(rect, 5, 'x')).toBe(0)
	})

	it('replaces a wide character that would straddle the rectangle edge with a blank', () => {
		const f = new Frame(10, 1)
		const used = f.writeText({ x: 0, y: 0, width: 3, height: 1 }, 0, 'ab中')
		expect(used).toBe(3)
		expect(f.cellAt(2, 0)?.ch).toBe(' ')
	})

	it('counts a black palette foreground as a real colour', () => {
		const f = new Frame(3, 1)
		f.fillRect({ x: 0, y: 0, width: 1, height: 1 }, { fg: 0 })
		expect(f.cellAt(0, 0)).not.toBe(BLANK_CELL)
		expect(f.cellAt(0, 0)?.fg).toBe(0)
	})
})

describe('diff writer', () => {
	it('reproduces a source screen exactly on a fresh terminal', async () => {
		const src = await screen(40, 6, COLORFUL)
		const f = new Frame(60, 8)
		f.blit(src.cells(), { x: 10, y: 1, width: 40, height: 6 })
		const out = new DiffWriter().render(f)
		const shown = await replay(60, 8, out)
		const view = shown.cells()
		for (let y = 0; y < 6; y++)
			for (let x = 0; x < 40; x++)
				expect(view.cell(x + 10, y + 1), `cell ${x},${y}`).toEqual(src.cells().cell(x, y))
		expect(view.cell(0, 0)).toBe(BLANK_CELL)
	})

	it('writes only the changed cells for a one-character change', async () => {
		const w = new DiffWriter()
		const f = new Frame(30, 5)
		f.writeText({ x: 0, y: 0, width: 30, height: 5 }, 2, 'hello world')
		w.render(f)
		f.set(4, 2, { ch: 'O', width: 1, fg: -1, bg: -1, attrs: 0 })
		const out = w.render(f)
		expect(out).toContain('\x1b[3;5H')
		expect(out.split(ESC_SEQUENCE).join('')).toBe('O')
	})

	it('writes nothing when neither cells nor cursor changed', () => {
		const w = new DiffWriter()
		const f = new Frame(10, 2)
		f.setCursor({ x: 1, y: 1, visible: true })
		w.render(f)
		expect(w.render(f)).toBe('')
	})

	it('moves and hides the cursor without touching cells', () => {
		const w = new DiffWriter()
		const f = new Frame(10, 2)
		f.setCursor({ x: 1, y: 1, visible: true })
		w.render(f)
		f.setCursor({ x: 3, y: 0, visible: true })
		expect(w.render(f)).toContain('\x1b[1;4H')
		f.setCursor({ x: 3, y: 0, visible: false })
		const hidden = w.render(f)
		expect(hidden).toContain('\x1b[?25l')
		expect(hidden).not.toContain('\x1b[?25h')
	})

	it('keeps a screen identical to the source across a series of updates', async () => {
		const src = new HeadlessScreen(30, 5, 0)
		const w = new DiffWriter()
		const chunks: string[] = []
		const frames = [
			'\x1b[1mtitle\x1b[0m\r\n中文',
			'\x1b[2;1H\x1b[0mab中文\x1b[K',
			'\x1b[1;1H\x1b[32mTITLE\x1b[0m',
			'\x1b[2J\x1b[H\x1b[?1049halt screen \x1b[44mblue\x1b[0m',
			'\x1b[?1049l',
		]
		for (const data of frames) {
			src.write(data)
			await src.settled()
			const f = new Frame(30, 5)
			f.blit(src.cells(), { x: 0, y: 0, width: 30, height: 5 })
			chunks.push(w.render(f))
		}
		const shown = await replay(30, 5, ...chunks)
		expect(cellsOf(shown)).toEqual(cellsOf(src))
	})

	it('repaints a wide character whose second half changed, and a narrow one that replaced a wide one', async () => {
		const w = new DiffWriter()
		const chunks: string[] = []
		const f = new Frame(8, 1)
		f.writeText({ x: 0, y: 0, width: 8, height: 1 }, 0, '中文ab')
		chunks.push(w.render(f))
		f.fillRect({ x: 0, y: 0, width: 8, height: 1 })
		f.writeText({ x: 0, y: 0, width: 8, height: 1 }, 0, 'x中文')
		chunks.push(w.render(f))
		const shown = await replay(8, 1, ...chunks)
		expect(shown.lines()[0]?.trimEnd()).toBe('x中文')
	})

	it('repaints everything after invalidate and after a size change', async () => {
		const w = new DiffWriter()
		const f = new Frame(10, 2)
		f.writeText({ x: 0, y: 0, width: 10, height: 2 }, 0, 'hi')
		w.render(f)
		w.invalidate()
		const again = w.render(f)
		expect(again).toContain('\x1b[2J')
		expect(again).toContain('hi')
		const bigger = new Frame(12, 3)
		bigger.writeText({ x: 0, y: 0, width: 12, height: 3 }, 0, 'hi')
		const out = w.render(bigger)
		expect(out).toContain('\x1b[2J')
		expect((await replay(12, 3, out)).lines()[0]).toBe('hi')
	})

	it('emits a style change once per run of equally styled cells', () => {
		const w = new DiffWriter()
		const f = new Frame(20, 1)
		f.writeText({ x: 0, y: 0, width: 20, height: 1 }, 0, 'aaaa', { fg: 1 })
		const out = w.render(f)
		expect(out.split(sgr(1, -1, 0)).length - 1).toBe(1)
	})
})
