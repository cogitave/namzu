import type { ToolDiffHunk } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import {
	type DiffInfo,
	HUNK_GAP,
	diffViewBody,
	diffViewRows,
	editSummary,
	expandTabs,
	fileViewRows,
	plainDiffRows,
	spansText,
	viewRowText,
} from './diff-view.js'
import {
	DIFF_COLORS_ANSI,
	DIFF_COLORS_TRUECOLOR,
	diffColors,
	reportsTruecolor,
	theme,
} from './theme.js'

const colors = DIFF_COLORS_TRUECOLOR
const hunk = (start: number, lines: string[], newStart = start): ToolDiffHunk => ({
	oldStart: start,
	oldLines: lines.filter((l) => !l.startsWith('+')).length,
	newStart,
	newLines: lines.filter((l) => !l.startsWith('-')).length,
	lines,
})

describe('a hunk row', () => {
	it('is a padded line number, a space, the marker, and the code straight after it', () => {
		const rows = diffViewRows([hunk(8, [' eight', '-nine', '+NINE', ' ten', ' eleven'])], {
			width: 30,
			colors,
		})
		expect(rows.map((row) => viewRowText(row).trimEnd())).toEqual([
			'  8  eight',
			'  9 -nine',
			'  9 +NINE',
			' 10  ten',
			' 11  eleven',
		])
	})

	it('fills an added or removed row to the width with its background, and leaves a context row bare', () => {
		const rows = diffViewRows([hunk(1, [' keep', '-old', '+new'])], { width: 20, colors })
		const [keep, removed, added] = rows
		expect(rows.map((row) => viewRowText(row).length)).toEqual([' 1  keep'.length, 20, 20])
		// Context: dim gutter, no background anywhere.
		expect(keep?.every((segment) => segment.bg === undefined)).toBe(true)
		expect(keep?.[0]).toMatchObject({ dim: true })
		// Removed and added: the background and the text colour on every segment.
		for (const [row, bg] of [
			[removed, colors.removed],
			[added, colors.added],
		] as const) {
			expect(row?.every((segment) => segment.bg === bg)).toBe(true)
			expect(row?.every((segment) => segment.fg === theme.text.primary)).toBe(true)
		}
	})

	it('numbers the rows that replace a removed run from the number the run started at', () => {
		const rows = diffViewRows([hunk(5, ['-a', '-b', '-c', '+x', '+y', ' tail'])], {
			width: 20,
			colors,
		})
		expect(rows.map((row) => viewRowText(row).slice(0, 4).trim())).toEqual([
			'5 -',
			'6 -',
			'7 -',
			'5 +',
			'6 +',
			'7',
		])
	})

	it('sizes the gutter to the widest number in the hunk', () => {
		const rows = diffViewRows([hunk(98, [' a', ' b', ' c'])], { width: 20, colors })
		expect(rows.map((row) => viewRowText(row))).toEqual(['  98  a', '  99  b', ' 100  c'])
	})

	it('joins hunks with a dim ...', () => {
		const rows = diffViewRows([hunk(1, ['-a', '+b']), hunk(50, ['-c', '+d'])], {
			width: 12,
			colors,
		})
		expect(rows).toHaveLength(5)
		expect(rows[2]).toEqual([{ text: HUNK_GAP, dim: true }])
	})

	it('wraps a long line inside the width and keeps a blank gutter on the rest', () => {
		const rows = diffViewRows([hunk(7, [`+${'abcdefghij'.repeat(3)}`])], { width: 16, colors })
		// Code room: 16 - 2 (gutter) - 1 (space) - 2 (reserve) = 11
		expect(rows.length).toBeGreaterThan(1)
		const text = rows.map(viewRowText)
		expect(text[0]?.startsWith(' 7 +abcdefghij')).toBe(true)
		for (const line of text.slice(1)) expect(line.startsWith('   +')).toBe(true)
		expect(text.every((line) => line.length === 16)).toBe(true)
		expect(text.map((line) => line.slice(4).trimEnd()).join('')).toBe('abcdefghij'.repeat(3))
	})

	it('expands tabs to stops of eight and names what a very long line left off', () => {
		expect(expandTabs('a\tb')).toBe('a       b')
		const rows = diffViewRows([hunk(1, [`+${'x'.repeat(2100)}`])], { width: 4000, colors })
		const text = viewRowText(rows[0] ?? [])
		expect(text).toContain(' … [+100 chars]')
		expect(rows[0]?.some((segment) => segment.dim && segment.text.includes('[+100 chars]'))).toBe(
			true,
		)
	})
})

describe('words that differ inside a changed pair', () => {
	const pair = hunk(1, ['-const total = price * count', '+const total = price * quantity'])

	it('get the stronger background on both rows, the rest keeps the row background', () => {
		const [removed, added] = diffViewRows([pair], { width: 60, colors })
		const marked = (row: typeof removed) =>
			row?.filter(
				(segment) => segment.bg === (row === removed ? colors.removedWord : colors.addedWord),
			)
		expect(marked(removed)?.map((segment) => segment.text)).toEqual(['count'])
		expect(marked(added)?.map((segment) => segment.text)).toEqual(['quantity'])
		const plain = added?.filter((segment) => segment.bg === colors.added).map((s) => s.text)
		expect(plain?.join('')).toContain('const total = price * ')
	})

	it('are left out when more than 0.4 of the pair differs', () => {
		const rows = diffViewRows([hunk(1, ['-alpha beta gamma', '+one two three'])], {
			width: 40,
			colors,
		})
		for (const row of rows) {
			expect(row.some((segment) => segment.bg === colors.removedWord)).toBe(false)
			expect(row.some((segment) => segment.bg === colors.addedWord)).toBe(false)
		}
	})

	it('are left out of a dimmed (refused) change', () => {
		const rows = diffViewRows([pair], { width: 60, colors, dim: true })
		for (const row of rows) {
			expect(row.every((segment) => segment.bg !== colors.addedWord)).toBe(true)
			expect(row.every((segment) => segment.bg !== colors.removedWord)).toBe(true)
			expect(row.some((segment) => segment.bg === colors.addedDimmed)).toBe(row === rows[1])
		}
	})

	it('pairs a removed run with an added run one for one, and leaves the surplus whole', () => {
		const rows = diffViewRows([hunk(1, ['-a b c d', '-solo line', '+a b c e'])], {
			width: 40,
			colors,
		})
		expect(rows[0]?.some((segment) => segment.bg === colors.removedWord)).toBe(true)
		expect(rows[1]?.some((segment) => segment.bg === colors.removedWord)).toBe(false)
	})
})

describe('a refused change', () => {
	it('uses the dimmed backgrounds and dims the text', () => {
		const rows = diffViewRows([hunk(1, ['-a', '+b'])], { width: 10, colors, dim: true })
		expect(rows[0]?.every((segment) => segment.bg === colors.removedDimmed && segment.dim)).toBe(
			true,
		)
		expect(rows[1]?.every((segment) => segment.bg === colors.addedDimmed && segment.dim)).toBe(true)
	})
})

describe('the palette', () => {
	it('is the reference values on a truecolor terminal and named ANSI colours elsewhere', () => {
		expect(colors).toEqual({
			added: 'rgb(34,92,43)',
			removed: 'rgb(122,41,54)',
			addedDimmed: 'rgb(71,88,74)',
			removedDimmed: 'rgb(105,72,77)',
			addedWord: 'rgb(56,166,96)',
			removedWord: 'rgb(179,89,107)',
		})
		expect(DIFF_COLORS_ANSI).toEqual({
			added: 'green',
			removed: 'red',
			addedDimmed: 'green',
			removedDimmed: 'red',
			addedWord: 'greenBright',
			removedWord: 'redBright',
		})
		expect(diffColors({ COLORTERM: 'truecolor' })).toBe(DIFF_COLORS_TRUECOLOR)
		expect(diffColors({ COLORTERM: '24bit' })).toBe(DIFF_COLORS_TRUECOLOR)
		expect(diffColors({ TERM: 'xterm-256color' })).toBe(DIFF_COLORS_ANSI)
		expect(reportsTruecolor({})).toBe(false)
	})
})

describe('the summary line', () => {
	it('reads Added N lines, removed M lines with the numbers bold', () => {
		const spans = editSummary(12, 1)
		expect(spansText(spans)).toBe('Added 12 lines, removed 1 line')
		expect(spans.filter((span) => span.bold).map((span) => span.text)).toEqual(['12', '1'])
		expect(spansText(editSummary(1, 2))).toBe('Added 1 line, removed 2 lines')
		expect(spansText(editSummary(0, 1))).toBe('Removed 1 line')
		expect(spansText(editSummary(1234, 0))).toBe('Added 1,234 lines')
	})
})

describe('a created file', () => {
	const lines = Array.from({ length: 14 }, (_, i) => `+line ${i + 1}`)
	const info: DiffInfo = {
		mode: 'file',
		hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 14, lines }],
		preview: 10,
		added: 14,
	}

	it('is its lines as they are, with no gutter and no marker', () => {
		expect(fileViewRows(info.hunks, { width: 40 }).map(viewRowText).slice(0, 2)).toEqual([
			'line 1',
			'line 2',
		])
	})

	it('shows ten rows, then how many are left behind the hint', () => {
		const rows = diffViewBody(info, { width: 40, expanded: false, canExpand: true }).map(
			viewRowText,
		)
		expect(rows).toHaveLength(11)
		expect(rows[9]).toBe('line 10')
		expect(rows[10]).toBe('… +4 lines (ctrl+o to expand)')
	})

	it('shows everything once expanded', () => {
		const rows = diffViewBody(info, { width: 40, expanded: true, canExpand: true })
		expect(rows).toHaveLength(14)
	})

	it('counts the lines the kernel did not carry among those left behind', () => {
		const cut: DiffInfo = { ...info, truncated: true, added: 500 }
		const rows = diffViewBody(cut, { width: 40, expanded: false, canExpand: true }).map(viewRowText)
		expect(rows.at(-1)).toBe('… +490 lines (ctrl+o to expand)')
	})
})

describe('an edit', () => {
	it('shows every hunk it carries, and says so when the kernel carried only part', () => {
		const many = Array.from({ length: 30 }, (_, i) => hunk(i * 20 + 1, ['-a', '+b']))
		const info: DiffInfo = { mode: 'hunks', hunks: many, added: 30, removed: 30 }
		const rows = diffViewBody(info, { width: 30, expanded: false, canExpand: true })
		expect(rows).toHaveLength(30 * 2 + 29)
		const cut = diffViewBody(
			{ ...info, truncated: true },
			{ width: 30, expanded: false, canExpand: true },
		)
		expect(viewRowText(cut.at(-1) ?? [])).toBe('… more changes are not shown')
	})
})

describe('a working tree', () => {
	it('draws a heading per file over its hunks, and a footer after the last', () => {
		const info: DiffInfo = {
			mode: 'hunks',
			hunks: [],
			files: [
				{ heading: 'a.txt +1 −1', hunks: [hunk(1, ['-x', '+y'])] },
				{ heading: 'b.txt +1', hunks: [hunk(1, ['+z'])] },
			],
			footer: ['', '… truncated. Run `git diff` for the rest.'],
		}
		expect(plainDiffRows(info)).toEqual([
			'a.txt +1 −1',
			' 1 -x',
			' 1 +y',
			'',
			'b.txt +1',
			' 1 +z',
			'',
			'… truncated. Run `git diff` for the rest.',
		])
		const rows = diffViewBody(info, { width: 30, expanded: false, canExpand: true })
		expect(viewRowText(rows[1] ?? []).trimEnd()).toBe(' 1 -x')
		expect(rows[1]?.[0]?.bg).toBe(DIFF_COLORS_TRUECOLOR.removed)
	})
})
