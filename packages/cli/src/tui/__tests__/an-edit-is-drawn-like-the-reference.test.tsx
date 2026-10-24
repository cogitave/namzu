/**
 * What a person sees of a change to a file: the header, the result line and the
 * hunks under it, read back from an emulated terminal (text AND cell colours).
 *
 * The rules are the reference terminal's own: the numbers are bold, an added or
 * removed row is filled to the edge with a background, the changed words in a
 * pair get a stronger one, hunks are joined by a dim `...`, and nothing but the
 * result line's own column sits to the left of the body.
 */

import { createRequire } from 'node:module'

import { Box } from 'ink'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import { diffBodyFromFacts, proposedBody } from '../diff-rows.js'
import { toolEndRows } from '../tool-end-rows.js'
import type { ToolEndEvent } from '../tool-end-rows.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level
const COLOR_VARS = ['COLORTERM', 'WT_SESSION', 'TERM_PROGRAM', 'TERM'] as const
const saved = Object.fromEntries(COLOR_VARS.map((name) => [name, process.env[name]]))

beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})
beforeEach(() => {
	// The machine running the suite may report truecolor; each test says what its terminal reports.
	for (const name of COLOR_VARS) delete process.env[name]
})

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
	for (const name of COLOR_VARS) {
		const value = saved[name]
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
})

const HUNKS = [
	{
		oldStart: 3,
		oldLines: 3,
		newStart: 3,
		newLines: 4,
		lines: [
			' keep',
			'-const total = price * count',
			'+const total = price * quantity',
			'+const tax = 2',
		],
	},
	{
		oldStart: 40,
		oldLines: 2,
		newStart: 41,
		newLines: 1,
		lines: ['-alpha beta gamma', '+one two three'],
	},
]

function editRows(): TranscriptMessage[] {
	const body = diffBodyFromFacts(
		{ kind: 'edit', path: '/work/src/a.ts', added: 3, removed: 2, hunks: HUNKS },
		'/work',
	)
	const event = {
		kind: 'tool-end',
		toolUseId: 't1',
		toolName: 'edit',
		isError: false,
		summary: 'Edited a.ts +3 −2',
		detail: body?.rows,
		...(body ? { diff: body.diff } : {}),
	} as ToolEndEvent
	const built = toolEndRows(event, { label: 'Update(src/a.ts)' }, { hasPlan: false })
	if (built.kind !== 'rows') throw new Error('expected rows')
	return built.rows.map((row, i) => ({ id: `r${i}`, ...row }))
}

async function show(messages: TranscriptMessage[], cols = 60) {
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			<Transcript
				messages={messages}
				pending={null}
				state="idle"
				settled={0}
				resetKey={0}
				staticIndent={1}
			/>
		</Box>,
		{ cols, rows: 24 },
	)
	return mounted
}

const lines = (screen: Screen) => screen.viewport().filter((line) => line.trim().length > 0)

describe('an accepted edit', () => {
	it('reads Update(path), then Added N lines, removed M lines, then the hunks', async () => {
		process.env.COLORTERM = 'truecolor'
		const screen = await show(editRows())
		const rows = lines(screen)
		expect(rows[0]).toContain('Update(src/a.ts)')
		expect(rows[1]).toContain('Added 3 lines, removed 2 lines')
		// Gutter, marker, code with nothing between marker and code.
		expect(rows[2]).toMatch(/^\s+3\s{2}keep\s*$/u)
		expect(rows[3]).toMatch(/^\s+4 -const total = price \* count\s*$/u)
		expect(rows[4]).toMatch(/^\s+4 \+const total = price \* quantity\s*$/u)
		expect(rows[5]).toMatch(/^\s+5 \+const tax = 2\s*$/u)
		expect(rows[6]?.trim()).toBe('...')
		expect(rows.some((row) => row.includes('▏'))).toBe(false)
	})

	it('bolds the numbers of the result line', async () => {
		process.env.COLORTERM = 'truecolor'
		const screen = await show(editRows())
		const row = screen.viewport().findIndex((line) => line.includes('Added 3 lines'))
		const col = screen.viewport()[row]?.indexOf('3') ?? -1
		expect(screen.cell(row, col).bold).toBe(true)
		expect(screen.cell(row, (screen.viewport()[row]?.indexOf('Added') ?? 0) + 1).bold).toBe(false)
	})

	it('fills added and removed rows to the edge with the reference backgrounds, words stronger', async () => {
		process.env.COLORTERM = 'truecolor'
		const screen = await show(editRows(), 60)
		const view = screen.viewport()
		const removed = view.findIndex((line) => line.includes('-const total = price * count'))
		const added = view.findIndex((line) => line.includes('+const total = price * quantity'))
		const keep = view.findIndex((line) => line.includes('keep'))
		const at = (row: number, text: string) => (view[row] ?? '').indexOf(text)
		// Row backgrounds, from the gutter to the last filled cell.
		const left = (view[removed] ?? '').search(/\S/u)
		expect(screen.cell(removed, left).bg).toBe('rgb:122,41,54')
		expect(screen.cell(added, left).bg).toBe('rgb:34,92,43')
		// Filled out to the width the body has: 60 columns, one of padding each side
		// and the two of the glyph column leave 56 for content, and the body keeps
		// one cell back from the edge.
		const reach = 1 + 2 + (56 - 1) - 1
		expect(screen.cell(removed, reach).bg).toBe('rgb:122,41,54')
		expect(screen.cell(added, reach).bg).toBe('rgb:34,92,43')
		// The words that differ.
		expect(screen.cell(removed, at(removed, 'count')).bg).toBe('rgb:179,89,107')
		expect(screen.cell(added, at(added, 'quantity')).bg).toBe('rgb:56,166,96')
		expect(screen.cell(removed, at(removed, 'total')).bg).toBe('rgb:122,41,54')
		// The code on a coloured row is the theme's text colour; context has no fill and a dim gutter.
		expect(screen.cell(added, at(added, 'const')).fg).not.toBe('default')
		expect(screen.cell(keep, at(keep, 'keep')).bg).toBe('default')
		expect(screen.cell(keep, left).dim).toBe(true)
		// The second hunk is too different for word highlights: whole rows only.
		const second = view.findIndex((line) => line.includes('+one two three'))
		expect(screen.cell(second, at(second, 'two')).bg).toBe('rgb:34,92,43')
	})

	it('uses named ANSI colours when the terminal does not report truecolor', async () => {
		const screen = await show(editRows(), 60)
		const view = screen.viewport()
		const removed = view.findIndex((line) => line.includes('-const total = price * count'))
		const added = view.findIndex((line) => line.includes('+const total = price * quantity'))
		const left = (view[removed] ?? '').search(/\S/u)
		// ANSI red is palette 1, green 2; the bright variants are 9 and 10.
		expect(screen.cell(removed, left).bg).toBe('palette:1')
		expect(screen.cell(added, left).bg).toBe('palette:2')
		expect(screen.cell(removed, (view[removed] ?? '').indexOf('count')).bg).toBe('palette:9')
		expect(screen.cell(added, (view[added] ?? '').indexOf('quantity')).bg).toBe('palette:10')
	})
})

describe('a created file', () => {
	it('reads Wrote N lines to <path>, then the first ten lines and the fold', async () => {
		const content = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`)
		const body = diffBodyFromFacts(
			{
				kind: 'write',
				path: '/work/notes.txt',
				operation: 'created',
				added: 14,
				hunks: [
					{
						oldStart: 0,
						oldLines: 0,
						newStart: 1,
						newLines: 14,
						lines: content.map((l) => `+${l}`),
					},
				],
			},
			'/work',
		)
		const built = toolEndRows(
			{
				kind: 'tool-end',
				toolUseId: 't',
				toolName: 'write',
				isError: false,
				summary: 'Created notes.txt +14',
				detail: body?.rows,
				...(body ? { diff: body.diff } : {}),
			} as ToolEndEvent,
			{ label: 'Write(notes.txt)' },
			{ hasPlan: false },
		)
		if (built.kind !== 'rows') throw new Error('expected rows')
		const messages = built.rows.map((row, i) => ({ id: `r${i}`, ...row, detailRef: 1 }))
		const screen = await show(messages)
		const rows = lines(screen)
		expect(rows[0]).toContain('Write(notes.txt)')
		expect(rows[1]).toContain('Wrote 14 lines to notes.txt')
		expect(rows.slice(2, 12).map((row) => row.trim())).toEqual(content.slice(0, 10))
		expect(rows[12]?.trim()).toBe('… +4 lines (ctrl+o to expand)')
		expect(rows).toHaveLength(13)
	})
})

describe('a refused edit', () => {
	it('keeps the plain sentence and shows what was turned down with the dimmed colours', async () => {
		process.env.COLORTERM = 'truecolor'
		const built = toolEndRows(
			{
				kind: 'tool-end',
				toolUseId: 't',
				toolName: 'edit',
				isError: true,
				summary: 'declined',
				declined: {},
			} as ToolEndEvent,
			{
				label: 'Update(a.ts)',
				proposed: { kind: 'edit', before: 'let a = 1', after: 'let a = 2' },
			},
			{ hasPlan: false },
		)
		if (built.kind !== 'rows') throw new Error('expected rows')
		expect(proposedBody({ kind: 'edit', before: 'x', after: 'y' })?.diff.dim).toBe(true)
		const screen = await show(built.rows.map((row, i) => ({ id: `r${i}`, ...row })))
		const view = screen.viewport()
		const rows = lines(screen)
		expect(rows[1]).toContain('You declined this')
		const removed = view.findIndex((line) => line.includes('-let a = 1'))
		const added = view.findIndex((line) => line.includes('+let a = 2'))
		expect(removed).toBeGreaterThan(0)
		const left = (view[removed] ?? '').search(/\S/u)
		expect(screen.cell(removed, left).bg).toBe('rgb:105,72,77')
		expect(screen.cell(added, left).bg).toBe('rgb:71,88,74')
		expect(screen.cell(added, (view[added] ?? '').indexOf('let')).dim).toBe(true)
	})
})
