/**
 * The workflow rows under the status row read as one table: a dim bullet, the
 * names in one column, the bars all starting in the same cell, then the count,
 * the clock and the tokens each under the same column of the row above. The
 * three rows are the shape a long session shows: one part-way through, two
 * just begun. Measured on the screen an emulator draws, at the widths the
 * terminal is used at.
 */

import { createRequire } from 'node:module'

import { Box, Text } from 'ink'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
	AgentTaskPanel,
	type RailWorkflow,
	layoutWorkflowRows,
	railWorkflowElapsed,
} from '../AgentExplorer.js'
import { BackgroundAgentRows } from '../BackgroundAgentRows.js'
import { type Screen, renderToScreen } from './support/screen.js'

const NOW = 10_000_000

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalColorLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalColorLevel
})

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

function flow(
	name: string,
	done: number,
	total: number,
	ranFor: number,
	wrote: number,
): RailWorkflow {
	return {
		id: name,
		focusId: `workflow:${name}`,
		name,
		startedAt: NOW - ranFor,
		done,
		total,
		outputTokens: wrote,
		failed: 0,
		status: 'running',
		agents: [],
	}
}

const MIN = 60_000
const HOUR = 60 * MIN

/** Fixed numbers: one row 5 of 9 after 1h58m, two just begun. */
const THREE_ROWS: readonly RailWorkflow[] = [
	flow('small-models-done-right', 5, 9, 1 * HOUR + 58 * MIN, 1_300_000),
	flow('looking-agents-not-forced', 0, 1, 16 * MIN + 8_000, 129_600),
	flow('tui-open-on-a-clean-screen', 0, 1, 13 * MIN + 35_000, 221_800),
]

async function rowsAt(cols: number, workflows: readonly RailWorkflow[] = THREE_ROWS) {
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			<AgentTaskPanel
				agents={[]}
				workflows={workflows}
				terminalRows={40}
				terminalColumns={cols}
				now={NOW}
			/>
		</Box>,
		{ cols, rows: 12 },
	)
	return mounted.viewport().filter((row) => row.trim().length > 0)
}

/** Cell index where a pattern first matches in a row. */
const at = (row: string | undefined, pattern: RegExp): number => row?.search(pattern) ?? -1

describe('the elapsed time of a workflow row', () => {
	it('keeps one compact shape per range, so the clocks of different rows line up', () => {
		expect(railWorkflowElapsed(45_000)).toBe('45s')
		expect(railWorkflowElapsed(16 * MIN + 8_000)).toBe('16m08s')
		expect(railWorkflowElapsed(13 * MIN + 35_000)).toBe('13m35s')
		expect(railWorkflowElapsed(HOUR + 58 * MIN + 12_000)).toBe('1h58m')
		expect(railWorkflowElapsed(2 * HOUR + 3 * MIN)).toBe('2h03m')
		expect(railWorkflowElapsed(26 * HOUR)).toBe('1d02h')
	})
})

describe('three workflow rows under the status row', () => {
	it.each([175, 100, 80])(
		'start each with the bullet and fill columns at %i columns',
		async (cols) => {
			const rows = await rowsAt(cols)
			expect(rows).toHaveLength(3)
			for (const row of rows) {
				expect(row.startsWith('  ◯ ')).toBe(true)
				expect([...row].length).toBeLessThanOrEqual(cols - 2)
			}
			// Names are one column wide: the longest name sets it.
			const longest = 'tui-open-on-a-clean-screen'.length
			const barAt = rows.map((row) => at(row, /[▰▱]/u))
			expect(new Set(barAt).size).toBe(1)
			expect(barAt[0]).toBe(4 + longest + 2)
			// The bars are the same width on every row.
			const widths = rows.map((row) => (row.match(/[▰▱]/gu) ?? []).length)
			expect(new Set(widths).size).toBe(1)
			// Count, clock and tokens each begin in one column.
			for (const pattern of [/\d\/\d/u, /(?<=\d\/\d · )\d/u, /↓/u]) {
				const starts = rows.map((row) => at(row, pattern))
				expect(starts.every((start) => start > 0)).toBe(true)
				expect(new Set(starts).size).toBe(1)
			}
		},
	)

	it('read as the screenshot reads: count, clock and tokens in their own columns', async () => {
		const rows = await rowsAt(175)
		expect(rows[0]).toContain('5/9 · 1h58m  · ↓ 1.3M tokens')
		expect(rows[1]).toContain('0/1 · 16m08s · ↓ 129.6k tokens')
		expect(rows[2]).toContain('0/1 · 13m35s · ↓ 221.8k tokens')
	})

	it('draw the bullet and everything after it dim', async () => {
		await rowsAt(100)
		const screen = mounted as Screen
		const painted = screen.viewport()
		let checked = 0
		for (const [index, text] of painted.entries()) {
			if (!text.includes('◯')) continue
			for (let col = 0; col < [...text].length; col += 1) {
				const cell = screen.cell(index, col)
				// The filled part of the bar is the one thing that is not dim.
				if (cell.char.trim().length === 0 || cell.char === '▰') continue
				expect(cell.dim).toBe(true)
				checked += 1
			}
		}
		expect(checked).toBeGreaterThan(60)
	})

	it('give up the bar the same way on every row as the terminal narrows', () => {
		const bars = (cols: number) =>
			layoutWorkflowRows(THREE_ROWS, NOW, cols, 26).map((layout) => layout.variant.barWidth)
		expect(bars(175)).toEqual([20, 20, 20])
		// The longest row sets the step: no row keeps a bar the others had to shrink.
		for (const cols of [100, 80, 72, 71, 64, 63, 60, 59, 56, 55, 50, 40]) {
			expect(new Set(bars(cols)).size).toBe(1)
		}
		const walk = [175, 100, 80, 72, 64, 56, 40].map((cols) => bars(cols)[0] as number)
		expect(walk).toEqual([...walk].sort((a, b) => b - a))
		const seen = new Set(Array.from({ length: 150 }, (_, i) => bars(i + 20)[0] as number))
		expect([...seen].sort((a, b) => b - a)).toEqual([20, 12, 8, 4, 0])
	})

	it.each([60, 50, 40, 30])('never wrap or run past the width at %i columns', async (cols) => {
		const rows = await rowsAt(cols)
		expect(rows).toHaveLength(3)
		for (const row of rows) expect([...row].length).toBeLessThanOrEqual(cols)
	})
})

describe('the wait line for background work', () => {
	it('sits in the same slot as the closing line: a blank row, the mark in a two-cell column, words from the third cell', async () => {
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<Text>Done with the first part.</Text>
				<BackgroundAgentRows
					groups={[]}
					waitLine="Waiting for 3 dynamic workflows to finish"
					glyph="✻"
				/>
			</Box>,
			{ cols: 60, rows: 6 },
		)
		const rows = mounted.viewport().map((row) => row.trimEnd())
		const start = rows.indexOf(' Done with the first part.')
		expect(rows[start + 1]).toBe('')
		expect(rows[start + 2]).toBe(' ✻ Waiting for 3 dynamic workflows to finish')
		expect(mounted.cell(start + 2, 1).char).toBe('✻')
		expect(mounted.cell(start + 2, 1).bold).toBe(true)
		expect(mounted.cell(start + 2, 3).char).toBe('W')
	})
})
