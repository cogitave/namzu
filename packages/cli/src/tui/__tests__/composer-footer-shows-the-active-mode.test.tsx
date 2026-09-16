/**
 * The composer footer draws exactly one active-mode state, on exactly one
 * row, at every width.
 *
 * The permission-mode badge used to live inside the message frame, above the
 * input, shown only when the mode differed from `prompt`; the model, effort
 * and working directory lived on a separate status line one blank row below
 * the frame. Both are now the same line, directly below the frame: see
 * docs/cli/terminal-design.md#the-composer-footer. This file pins the three
 * states that line can be in, and that it never grows past one row doing it.
 */

import { Box } from 'ink'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { StatusBar } from '../StatusBar.js'
import { renderToScreen } from './support/screen.js'

const CWD = '/home/dev/work/namzu'
const ROWS = 24

/** The bar pinned to the foot of a full-height column, as in status-bar-sits-on-the-bottom-row.test.tsx. */
function bottomPinned(child: ReactElement) {
	return (
		<Box flexDirection="column" height={ROWS}>
			<Box flexGrow={1} />
			{child}
		</Box>
	)
}

const noSpecialMode = (
	<StatusBar cwd={CWD} provider="a-provider" model="gpt-5.6-terra" state="idle" />
)
const autoMode = (
	<StatusBar
		cwd={CWD}
		provider="a-provider"
		model="gpt-5.6-terra"
		state="idle"
		permissionMode="auto"
		canCycleMode
	/>
)
const planWithEffort = (
	<StatusBar
		cwd={CWD}
		provider="a-provider"
		model="gpt-5.6-terra"
		effort="high"
		state="idle"
		permissionMode="plan"
		canCycleMode
	/>
)

describe('the composer footer at 80 columns', () => {
	it('shows the quiet cycle reminder, the cwd and the model when no special mode is active', async () => {
		const screen = await renderToScreen(bottomPinned(noSpecialMode), { cols: 80, rows: ROWS })
		try {
			const row = screen.row(-1)
			expect(row).toContain('shift+tab to cycle')
			expect(row).toContain(CWD)
			expect(row.trimEnd()).toMatch(/gpt-5\.6-terra$/)
			expect(row).not.toContain('⏵⏵')
			expect(row).not.toContain('⏸')
			expect(row).not.toContain('effort')
		} finally {
			await screen.unmount()
		}
	})

	it('shows the auto badge with its cycle key, the cwd and the model', async () => {
		const screen = await renderToScreen(bottomPinned(autoMode), { cols: 80, rows: ROWS })
		try {
			const row = screen.row(-1)
			expect(row).toContain('⏵⏵ Auto-approve tools (shift+tab to cycle)')
			expect(row).toContain('work/namzu')
			expect(row.trimEnd()).toMatch(/gpt-5\.6-terra$/)
		} finally {
			await screen.unmount()
		}
	})

	it('shows the plan badge with its effort beside it and the model', async () => {
		const screen = await renderToScreen(bottomPinned(planWithEffort), { cols: 80, rows: ROWS })
		try {
			const row = screen.row(-1)
			expect(row).toContain('⏸ Plan (read-only) (shift+tab to cycle) · effort high')
			expect(row.trimEnd()).toMatch(/gpt-5\.6-terra$/)
		} finally {
			await screen.unmount()
		}
	})
})

describe('the composer footer at 40 columns', () => {
	it('keeps the quiet reminder and the model when no special mode is active', async () => {
		const screen = await renderToScreen(bottomPinned(noSpecialMode), { cols: 40, rows: ROWS })
		try {
			const row = screen.row(-1)
			expect(row).toContain('shift+tab to cycle')
			expect(row).toContain('gpt-5.6-terra')
		} finally {
			await screen.unmount()
		}
	})

	it('drops the cycle-key reminder before the badge itself shortens', async () => {
		const screen = await renderToScreen(bottomPinned(autoMode), { cols: 40, rows: ROWS })
		try {
			const row = screen.row(-1)
			expect(row, 'the badge was truncated before its cheaper neighbors were dropped').toContain(
				'⏵⏵ Auto-approve tools',
			)
			expect(row).not.toContain('shift+tab to cycle')
		} finally {
			await screen.unmount()
		}
	})

	it('keeps the mode badge whole even once the model is dropped for room', async () => {
		const screen = await renderToScreen(bottomPinned(planWithEffort), { cols: 40, rows: ROWS })
		try {
			const row = screen.row(-1)
			expect(row).toContain('⏸ Plan (read-only)')
		} finally {
			await screen.unmount()
		}
	})
})

describe('the composer footer never grows past one line', () => {
	it.each([20, 30, 40, 60, 80, 120])(
		'stays alone on the bottom row at %d columns',
		async (cols) => {
			const screen = await renderToScreen(bottomPinned(planWithEffort), { cols, rows: ROWS })
			try {
				expect(screen.row(-2), 'a second row means the footer wrapped').toBe('')
				expect(screen.row(-1).length).toBeLessThanOrEqual(cols)
			} finally {
				await screen.unmount()
			}
		},
	)
})
