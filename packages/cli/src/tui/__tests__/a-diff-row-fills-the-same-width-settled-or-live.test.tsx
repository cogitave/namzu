/**
 * A changed row is filled to the edge of its box and never cut: it is the same
 * width while it is still in the live part of the screen and after it has
 * settled into scrollback, at a wide and at a narrow terminal. A result body
 * (a diff, a created file, any other output) hangs from the column the result's
 * own words start in, like a shell call's output.
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
const chalk = (await import(inkRequire.resolve('chalk'))).default as {
	level: number
}
const originalLevel = chalk.level

beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})
beforeEach(() => {
	process.env.COLORTERM = 'truecolor'
})

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
	process.env.COLORTERM = undefined
	// biome-ignore lint/performance/noDelete: an unset variable, not the string "undefined".
	delete process.env.COLORTERM
})

const lineRange = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => `export const value${from + i} = ${from + i}`)

const TWO_HUNKS = [
	{
		oldStart: 1,
		oldLines: 7,
		newStart: 1,
		newLines: 7,
		lines: [
			...lineRange(1, 2).map((l) => ` ${l}`),
			'-export const value3 = 3',
			'+export const value3 = 33',
			...lineRange(4, 6).map((l) => ` ${l}`),
		],
	},
	{
		oldStart: 21,
		oldLines: 6,
		newStart: 21,
		newLines: 7,
		lines: [
			...lineRange(21, 23).map((l) => ` ${l}`),
			'-export const value24 = 24',
			'+export const value24 = 240',
			'+export const extra24 = 241',
			' export const value25 = 25',
		],
	},
]

function editRows(): TranscriptMessage[] {
	const body = diffBodyFromFacts(
		{
			kind: 'edit',
			path: '/work/src/multi.ts',
			added: 3,
			removed: 2,
			hunks: TWO_HUNKS,
		},
		'/work',
	)
	const built = toolEndRows(
		{
			kind: 'tool-end',
			toolUseId: 't1',
			toolName: 'edit',
			isError: false,
			summary: 'Edited multi.ts',
			detail: body?.rows,
			...(body ? { diff: body.diff } : {}),
		} as ToolEndEvent,
		{ label: 'Update(src/multi.ts)' },
		{ hasPlan: false },
	)
	if (built.kind !== 'rows') throw new Error('expected rows')
	return built.rows.map((row, i) => ({ id: `e${i}`, ...row }))
}

function declined(toolName: 'edit' | 'write'): TranscriptMessage[] {
	const proposed =
		toolName === 'edit'
			? ({ kind: 'edit', before: 'let a = 1', after: 'let a = 2' } as const)
			: ({ kind: 'write', content: 'one\ntwo\nthree' } as const)
	expect(proposedBody(proposed)).toBeDefined()
	const built = toolEndRows(
		{
			kind: 'tool-end',
			toolUseId: 'd',
			toolName,
			isError: true,
			summary: 'declined',
			declined: {},
		} as ToolEndEvent,
		{ label: toolName === 'edit' ? 'Update(a.ts)' : 'Write(a.ts)', proposed },
		{ hasPlan: false },
	)
	if (built.kind !== 'rows') throw new Error('expected rows')
	return built.rows.map((row, i) => ({ id: `d${i}`, ...row }))
}

async function show(messages: TranscriptMessage[], cols: number, settled: number) {
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			<Transcript
				messages={messages}
				pending={null}
				state="idle"
				settled={settled}
				resetKey={0}
				staticIndent={1}
			/>
		</Box>,
		{ cols, rows: 40 },
	)
	return mounted
}

/** Every row of the screen that carries a diff background in its first changed cell. */
function filledRows(screen: Screen) {
	const view = screen.viewport()
	const out: { row: number; text: string; first: number; last: number }[] = []
	view.forEach((text, row) => {
		const first = text.search(/[+-]/u)
		if (first < 0 || text.trim().length === 0) return
		const bg = screen.cell(row, first).bg
		if (bg === 'default' || bg === undefined) return
		out.push({ row, text, first, last: text.length - 1 })
	})
	return out
}

const CASES: readonly [string, () => TranscriptMessage[]][] = [
	['an edit with two hunks', editRows],
	['a declined edit', () => declined('edit')],
]

describe('a filled diff row', () => {
	for (const cols of [100, 60]) {
		for (const settled of [0, 99]) {
			for (const [name, make] of CASES) {
				it(`ends in a background space, not an ellipsis: ${name}, ${cols} columns, ${settled === 0 ? 'live' : 'settled'}`, async () => {
					const screen = await show(make(), cols, settled)
					const filled = filledRows(screen)
					expect(filled.length).toBeGreaterThanOrEqual(2)
					for (const { row, text, last } of filled) {
						expect(text).not.toContain('…')
						expect(text[last]).toBe(' ')
						expect(screen.cell(row, last).bg).toBe(screen.cell(row, last - 1).bg)
					}
					const view = screen.viewport().join('\n')
					expect(view).not.toContain('…')
				})
			}
		}
	}

	it('is the same width live and settled', async () => {
		const live = filledRows(await show(editRows(), 100, 0)).map((r) => r.text.length)
		await mounted?.unmount()
		const settled = filledRows(await show(editRows(), 100, 99)).map((r) => r.text.length)
		expect(settled).toEqual(live)
	})
})

describe('a result body', () => {
	const column = (screen: Screen, needle: string) => {
		const row = screen.viewport().find((line) => line.includes(needle))
		return row?.indexOf(needle) ?? -1
	}

	it('hangs a diff from the column the result words start in', async () => {
		const screen = await show(editRows(), 100, 0)
		const summary = column(screen, 'Added 3 lines')
		const [first] = filledRows(screen)
		expect(first).toBeDefined()
		// The gutter is right-aligned inside the hunk, so the widest number starts at the column.
		const fill = (first as { first: number }).first
		expect(screen.viewport()[(first as { row: number }).row]?.search(/\S/u)).toBeGreaterThanOrEqual(
			summary,
		)
		expect(fill).toBeGreaterThan(summary)
	})

	it('hangs a created file from the same column', async () => {
		const content = Array.from({ length: 4 }, (_, i) => `line ${i + 1}`)
		const body = diffBodyFromFacts(
			{
				kind: 'write',
				path: '/work/notes.txt',
				operation: 'created',
				added: 4,
				hunks: [
					{
						oldStart: 0,
						oldLines: 0,
						newStart: 1,
						newLines: 4,
						lines: content.map((l) => `+${l}`),
					},
				],
			},
			'/work',
		)
		const built = toolEndRows(
			{
				kind: 'tool-end',
				toolUseId: 'w',
				toolName: 'write',
				isError: false,
				summary: 'Created notes.txt',
				detail: body?.rows,
				...(body ? { diff: body.diff } : {}),
			} as ToolEndEvent,
			{ label: 'Write(notes.txt)' },
			{ hasPlan: false },
		)
		if (built.kind !== 'rows') throw new Error('expected rows')
		const screen = await show(
			built.rows.map((row, i) => ({ id: `w${i}`, ...row })),
			100,
			0,
		)
		expect(column(screen, 'line 1')).toBe(column(screen, 'Wrote 4 lines'))
		expect(column(screen, 'line 4')).toBe(column(screen, 'Wrote 4 lines'))
	})

	it('hangs any other output from that column too', async () => {
		const screen = await show(
			[
				{ id: 'h', role: 'tool', content: 'Read(a.ts)', glyph: '●' },
				{
					id: 'r',
					role: 'tool',
					content: 'Read a.ts',
					glyph: '⎿',
					detail: ['first body line', 'second body line'],
				},
			],
			100,
			0,
		)
		expect(column(screen, 'first body line')).toBe(column(screen, 'Read a.ts'))
		expect(column(screen, 'second body line')).toBe(column(screen, 'Read a.ts'))
	})
})
