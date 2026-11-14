/**
 * The update notice is its own row directly above the input box's upper rule,
 * flush right, and the status row under the box keeps the model label.
 *
 * Read from an emulated terminal (see support/screen.ts): the row geometry is
 * what is claimed, and a frame string cannot say it. The notice is a fixed
 * prop, because a stub cannot make the updater report an installed update.
 */

import { createRequire } from 'node:module'

import { Box } from 'ink'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ComposerFrame } from '../ComposerFrame.js'
import { StatusBar } from '../StatusBar.js'
import { UpdateNoticeRow, fitUpdateNotice } from '../UpdateNoticeRow.js'
import { theme } from '../theme.js'
import { updaterEventAmbient } from '../update-notice.js'
import { upperRuleRow } from './support/composer-rules.js'
import { renderToScreen } from './support/screen.js'

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})

const installed = updaterEventAmbient({ type: 'installed', from: '1.0.0', to: '1.1.0' })
const failed = updaterEventAmbient({
	type: 'failed',
	latest: '2.0.0',
	current: '1.0.0',
	code: 'verify_failed',
})

function bottom(options: {
	cols: number
	notice: ReturnType<typeof updaterEventAmbient> | null
	critical?: boolean
	mode?: string
	shells?: number
	monitors?: number
}) {
	return (
		<Box flexDirection="column" paddingX={1}>
			<ComposerFrame
				columns={options.cols - 2}
				{...(options.mode ? { mode: options.mode } : {})}
				above={
					<UpdateNoticeRow
						notice={options.notice}
						columns={options.cols - 2}
						critical={options.critical === true}
					/>
				}
			>
				<Box height={1} />
			</ComposerFrame>
			<StatusBar
				provider="p"
				model="a-model"
				state="idle"
				shellCount={options.shells ?? 0}
				monitorCount={options.monitors ?? 0}
			/>
		</Box>
	)
}

describe('fitUpdateNotice', () => {
	it('ends on the last column and cuts the end past 60% of the width', () => {
		const text = installed.text
		const wide = fitUpdateNotice(text, 175)
		expect(wide.text).toBe(text)
		expect(wide.indent + [...wide.text].length).toBe(175)
		const narrow = fitUpdateNotice(text, 40)
		expect([...narrow.text].length).toBe(24)
		expect(narrow.text.endsWith('…')).toBe(true)
		expect(narrow.text.startsWith('✓ Updated to 1.1.0')).toBe(true)
		expect(narrow.indent + 24).toBe(40)
	})
})

describe.each([175, 100])('the bottom of the screen at %i columns', (cols) => {
	const rows = 40

	it('draws an installed update on the row above the upper rule, green, ending in the last column', async () => {
		const screen = await renderToScreen(bottom({ cols, notice: installed }), { cols, rows })
		try {
			const view = screen.viewport()
			const rule = upperRuleRow(view)
			expect(rule).toBeGreaterThan(0)
			const at = rule - 1
			expect(view[at]).toContain('✓ Updated to 1.1.0 · restart to use it')
			expect(view[at]?.startsWith(' ')).toBe(true)
			// The row ends one cell before the edge: the app's own side padding.
			expect([...(view[at] ?? '')].length).toBe(cols - 1)
			const first = (view[at] ?? '').indexOf('✓')
			const fg = screen.cell(at, first).fg
			expect(fg).not.toBe('default')
			expect(fg).not.toBe(screen.cell(rule, 1).fg)
			// The status row keeps the model label.
			const status = view[rule + 3] ?? ''
			expect(status.trimEnd().endsWith('a-model')).toBe(true)
			expect(status).not.toContain('Updated')
		} finally {
			await screen.unmount()
		}
	})

	it('draws a failure dim, and nothing at all when there is no notice', async () => {
		const withFailure = await renderToScreen(bottom({ cols, notice: failed }), { cols, rows })
		try {
			const view = withFailure.viewport()
			const at = upperRuleRow(view) - 1
			expect(view[at]).toContain('could not start here')
			const tone = withFailure.cell(at, (view[at] ?? '').indexOf('Namzu')).fg
			expect(tone).not.toBe('default')
			// Not the installed colour: a failure is the quiet tone.
			const done = await renderToScreen(bottom({ cols, notice: installed }), { cols, rows })
			try {
				const row = done.viewport()
				const line = upperRuleRow(row) - 1
				expect(done.cell(line, (row[line] ?? '').indexOf('✓')).fg).not.toBe(tone)
			} finally {
				await done.unmount()
			}
		} finally {
			await withFailure.unmount()
		}
		const quiet = await renderToScreen(bottom({ cols, notice: null }), { cols, rows })
		try {
			const view = quiet.viewport()
			const rule = upperRuleRow(view)
			expect(view.slice(0, rule).join('\n')).not.toMatch(/Update|Updated|Namzu 2/)
			// One row less than with a notice.
			expect(view.filter((row) => row.trim() !== '').length).toBe(3)
			expect(view[rule - 1]).toBe('')
		} finally {
			await quiet.unmount()
		}
	})

	it('is hidden while a critical notice shows', async () => {
		const screen = await renderToScreen(bottom({ cols, notice: installed, critical: true }), {
			cols,
			rows,
		})
		try {
			expect(screen.viewport().join('\n')).not.toContain('Updated to')
		} finally {
			await screen.unmount()
		}
	})

	it('leaves the hypermode label on the rule and names the background pills', async () => {
		const screen = await renderToScreen(
			bottom({ cols, notice: installed, mode: 'hypermode', shells: 2, monitors: 1 }),
			{ cols, rows },
		)
		try {
			const view = screen.viewport()
			const rule = view.findIndex((row) => row.includes('hypermode'))
			expect(rule).toBeGreaterThan(0)
			expect(view[rule - 1]).toContain('Updated to 1.1.0')
			expect(view[rule + 3]).toContain('2 shells · 1 monitor')
			expect(view[rule + 3]?.trimEnd().endsWith('a-model')).toBe(true)
		} finally {
			await screen.unmount()
		}
	})
})

it('draws the installed tone from the ok colour', () => {
	expect(installed.tone).toBe('ok')
	expect(theme.status.ok).not.toBe(theme.text.muted)
})
