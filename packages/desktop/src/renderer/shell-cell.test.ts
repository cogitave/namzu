import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ShellCell } from './shell-cell-view.js'
import { type ShellCellData, shellCellRows } from './shell-cell.js'

const lines = (count: number, prefix = 'l') =>
	Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join('\n')
const stream = (count: number, prefix = 'l') => ({
	head: lines(count, prefix),
	omitted: 0,
	total: count,
})

it('shows the first three lines of what a command printed, then how many more', () => {
	const rows = shellCellRows({ failed: false, stdout: stream(40) }, false)
	expect(rows.lines.map((line) => line.text)).toEqual(['l1', 'l2', 'l3'])
	expect(rows.hidden).toBe(37)
	expect(rows.note).toBeUndefined()
	expect(shellCellRows({ failed: false, stdout: stream(40) }, true).lines).toHaveLength(40)
})

it('shows a single hidden line instead of saying it is hidden', () => {
	const rows = shellCellRows({ failed: false, stdout: stream(4) }, false)
	expect(rows.lines).toHaveLength(4)
	expect(rows.hidden).toBe(0)
})

it('puts stderr after stdout in the error tone, and gives a failed command the longer preview', () => {
	const cell: ShellCellData = {
		failed: true,
		status: 'Exit code 3',
		stdout: stream(2, 'o'),
		stderr: stream(12, 'e'),
	}
	const rows = shellCellRows(cell, false)
	expect(rows.lines.slice(0, 2).map((line) => line.tone)).toEqual(['out', 'out'])
	expect(rows.lines.filter((line) => line.tone === 'err')).toHaveLength(10)
	expect(rows.hidden).toBe(2)
	expect(rows.note).toBe('Exit code 3')
	expect(rows.noteTone).toBe('err')
})

it('says how a command ended once, and says so when it printed nothing', () => {
	expect(shellCellRows({ failed: true, status: 'Exit code 3' }, false)).toMatchObject({
		lines: [],
		note: 'Exit code 3',
	})
	expect(shellCellRows({ failed: false }, false).note).toBe('(No output)')
	expect(shellCellRows({ failed: false, background: true }, false).note).toBe(
		'Running in the background',
	)
	expect(shellCellRows({ failed: false, notice: 'Binary output, 3 KB' }, false).note).toBe(
		'Binary output, 3 KB',
	)
})

it('keeps the gap the runtime left in a long stream when expanded', () => {
	const rows = shellCellRows(
		{ failed: false, stdout: { head: 'a\nb\nc', tail: 'y\nz', omitted: 500, total: 505 } },
		true,
	)
	expect(rows.lines.map((line) => line.text)).toEqual([
		'a',
		'b',
		'c',
		'… 500 lines not shown',
		'y',
		'z',
	])
})

it('draws a cell with a fold button that names the hidden count', () => {
	const html = renderToStaticMarkup(
		createElement(ShellCell, { cell: { failed: false, stdout: stream(10) } }),
	)
	expect(html).toContain('+7 lines')
	expect(html).toContain('aria-expanded="false"')
	expect(renderToStaticMarkup(createElement(ShellCell, { cell: { failed: false } }))).toContain(
		'(No output)',
	)
})
