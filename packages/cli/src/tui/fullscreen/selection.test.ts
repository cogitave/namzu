import { describe, expect, it } from 'vitest'

import { createClipboardCopier } from '../../integrations/clipboard/copy.js'
import { ClickCounter } from '../../workspaces/selection.js'
import type { TranscriptMessage } from '../types.js'
import { cellRangeOf, sliceCells, widthOf } from './cells.js'
import { wrapJoiners } from './joiners.js'
import { createLayoutCache, fullscreenMessageRows, layoutTranscript } from './layout.js'
import type { FsRow } from './rows.js'
import { landOn, rowCells, rowsSource, selectedText, selectionRange } from './selection.js'
import type { Geometry, Selection } from './selection.js'

function row(text: string, joins: FsRow['joins'] = null, lead = 0): FsRow {
	return { glyph: ' ', glyphColor: '#fff', text, color: '#fff', joins, lead }
}

const pick = (
	rows: readonly FsRow[],
	cols: number,
	a: [number, number],
	b: [number, number],
	mode: Selection['mode'] = 'char',
) =>
	selectedText(rows, cols, {
		anchor: { line: a[0], col: a[1] },
		focus: { line: b[0], col: b[1] },
		mode,
	})

describe('cells', () => {
	it('counts a wide character as two cells and a combining mark as none', () => {
		expect(widthOf('a漢b')).toBe(4)
		expect(widthOf('🎉')).toBe(2)
		expect(widthOf('éx')).toBe(2)
	})

	it('slices by the cell a character starts in, never through a wide one', () => {
		expect(sliceCells('a漢字b', 0, 1)).toBe('a')
		expect(sliceCells('a漢字b', 1, 3)).toBe('漢')
		expect(sliceCells('a漢字b', 2, 4)).toBe('字')
		expect(sliceCells('a漢字b', 1, 5)).toBe('漢字')
	})

	it('maps a string range to the cells it is drawn in', () => {
		expect(cellRangeOf('a漢字b', 1, 3)).toEqual([1, 5])
	})
})

describe('where a pointer report lands', () => {
	// Ten rows of window starting at screen row 3, one of them the footer; rows 20..28 drawn.
	const g: Geometry = { top: 3, height: 10, from: 20, to: 29, footer: 1, left: 4, cols: 30 }

	it('maps a screen row to the row drawn there, counting up from the bottom edge', () => {
		// The window's last screen row is 12; the footer is on it; the last text row is 11.
		expect(landOn(g, 4, 11)).toEqual({ kind: 'on', point: { line: 28, col: 0 } })
		expect(landOn(g, 4, 10)).toEqual({ kind: 'on', point: { line: 27, col: 0 } })
	})

	it('maps a screen column to a cell of text, clamped to the row', () => {
		expect(landOn(g, 9, 11)).toMatchObject({ point: { col: 5 } })
		expect(landOn(g, 1, 11)).toMatchObject({ point: { col: 0 } })
		expect(landOn(g, 200, 11)).toMatchObject({ point: { col: 29 } })
	})

	it('says when the pointer is beyond the rows drawn', () => {
		expect(landOn(g, 4, 2).kind).toBe('above')
		expect(landOn(g, 4, 12).kind).toBe('below')
		expect(landOn(g, 4, 20).kind).toBe('outside')
	})

	it('has nothing under it before there are rows', () => {
		expect(landOn({ ...g, from: 0, to: 0 }, 4, 5).kind).toBe('outside')
	})
})

describe('what a selection copies', () => {
	it('is the plain text between two cells of one row', () => {
		const rows = [row('hello world')]
		expect(pick(rows, 40, [0, 6], [0, 10])).toBe('world')
		// Dragging backwards selects the same thing.
		expect(pick(rows, 40, [0, 10], [0, 6])).toBe('world')
	})

	it('takes whole rows between the first and last, one line each', () => {
		const rows = [row('first line'), row('second line'), row('third line')]
		expect(pick(rows, 40, [0, 6], [2, 4])).toBe('line\nsecond line\nthird')
	})

	it('joins a row the wrap continued with the space it broke at', () => {
		const rows = [row('one two three', null), row('four five', ' ')]
		expect(pick(rows, 40, [0, 0], [1, 8])).toBe('one two three four five')
	})

	it('joins a word cut by the wrap with nothing', () => {
		const rows = [row('https://example.c', null), row('om/path', '')]
		expect(pick(rows, 40, [0, 0], [1, 6])).toBe('https://example.com/path')
	})

	it('leaves out a hanging indent when it joins the rows', () => {
		const rows = [row('• item that wraps', null), row('  here', ' ', 2)]
		expect(pick(rows, 40, [0, 0], [1, 5])).toBe('• item that wraps here')
	})

	it('keeps the break between two lines, and a blank line between paragraphs', () => {
		const rows = [row('one'), row(''), row('two')]
		expect(pick(rows, 40, [0, 0], [2, 2])).toBe('one\n\ntwo')
	})

	it('never copies the gutter or a trailing blank', () => {
		const rows: FsRow[] = [{ ...row('text   '), glyph: '∴' }]
		expect(pick(rows, 40, [0, 0], [0, 39])).toBe('text')
	})

	it('does not cut a wide character in half, and counts it as two cells', () => {
		const rows = [row('a漢字b')]
		// Cell 2 is the second half of 漢: the whole character is taken.
		expect(pick(rows, 40, [0, 2], [0, 3])).toBe('漢字')
		expect(pick(rows, 40, [0, 1], [0, 1])).toBe('漢')
		expect(pick(rows, 40, [0, 4], [0, 5])).toBe('字b')
	})

	it('copies emoji and combining sequences whole', () => {
		const rows = [row('x🎉y éz')]
		expect(pick(rows, 40, [0, 1], [0, 2])).toBe('🎉')
		expect(pick(rows, 40, [0, 5], [0, 5])).toBe('é')
	})

	it('selects a word on a double click and the whole line on a triple', () => {
		const rows = [row('call the-function(arg) now', null), row('and more', ' ')]
		expect(pick(rows, 40, [0, 7], [0, 7], 'word')).toBe('the-function')
		expect(pick(rows, 40, [0, 7], [0, 7], 'line')).toBe('call the-function(arg) now and more')
	})

	it('selects a word of wide characters as one', () => {
		const rows = [row('say 漢字漢字 now')]
		expect(pick(rows, 40, [0, 5], [0, 5], 'word')).toBe('漢字漢字')
	})

	it('reports the cells of each row a range covers, within its text', () => {
		const rows = [row('abc'), row('defgh'), row('ij')]
		const range = selectionRange(rowsSource(rows, 40), {
			anchor: { line: 0, col: 1 },
			focus: { line: 2, col: 0 },
			mode: 'char',
		})
		expect(rowCells(range, 0, 'abc', 40)).toEqual([1, 3])
		expect(rowCells(range, 1, 'defgh', 40)).toEqual([0, 5])
		expect(rowCells(range, 2, 'ij', 40)).toEqual([0, 1])
		expect(rowCells(range, 3, '', 40)).toBeUndefined()
	})
})

describe('a wrap is read back from its source', () => {
	it('finds the space a wrapper dropped and the word it cut', () => {
		expect(wrapJoiners('alpha beta gamma', ['alpha beta', 'gamma'])).toEqual([null, ' '])
		expect(wrapJoiners('abcdefgh', ['abcd', 'efgh'])).toEqual([null, ''])
		expect(wrapJoiners('one\ntwo', ['one', 'two'])).toEqual([null, null])
		expect(wrapJoiners('one\n\ntwo three', ['one', '', 'two', 'three'])).toEqual([
			null,
			null,
			null,
			' ',
		])
	})

	it('carries them through a laid-out message', () => {
		const message: TranscriptMessage = {
			id: 'u',
			role: 'user',
			content: 'alpha beta gamma delta\nepsilon',
		}
		const rows = fullscreenMessageRows(message, false, 12).rows
		expect(rows.map((r) => r.text)).toEqual(['alpha beta', 'gamma delta', 'epsilon'])
		expect(rows.map((r) => r.joins)).toEqual([null, ' ', null])
	})

	it('copies a wrapped reply as the lines it was written in', () => {
		const message: TranscriptMessage = {
			id: 'a',
			role: 'assistant',
			content: 'alpha beta gamma delta epsilon zeta eta theta',
		}
		const { rows } = layoutTranscript([message], null, undefined, 20, createLayoutCache())
		expect(rows.length).toBeGreaterThan(1)
		expect(pick(rows, 18, [0, 0], [rows.length - 1, 17])).toBe(message.content)
	})
})

describe('clicks', () => {
	it('counts presses in one place within the window as a double and a triple click', () => {
		let now = 1_000
		const counter = new ClickCounter(() => now, 400)
		expect(counter.press(5, 5)).toBe(1)
		now += 200
		expect(counter.press(5, 5)).toBe(2)
		now += 200
		expect(counter.press(5, 5)).toBe(3)
		now += 900
		expect(counter.press(5, 5)).toBe(1)
		now += 100
		expect(counter.press(6, 5)).toBe(1)
	})
})

describe('putting the selection on the clipboard', () => {
	it('sends the plain text as an OSC 52 request', async () => {
		const written: string[] = []
		const copier = createClipboardCopier(
			{ isTTY: true, write: (data) => void written.push(data) },
			{
				platform: 'linux',
				env: { SSH_TTY: '/dev/pts/1' },
				run: async () => false,
			},
		)
		const text = pick([row('hello 漢字 🎉')], 40, [0, 0], [0, 39])
		const outcome = await copier.copy(text)
		expect(outcome?.osc52).toBe('sent')
		const sequence = written.join('')
		expect(sequence.startsWith('\x1b]52;c;')).toBe(true)
		expect(sequence.endsWith('\x07')).toBe(true)
		const encoded = sequence.slice('\x1b]52;c;'.length, -1)
		expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('hello 漢字 🎉')
	})
})
