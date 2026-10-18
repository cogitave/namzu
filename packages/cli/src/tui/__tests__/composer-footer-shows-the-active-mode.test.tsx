/**
 * The composer footer draws exactly one active-mode state, on exactly one
 * row, directly below the message frame's bottom border — at every width.
 *
 * The permission-mode badge used to live inside the message frame, above the
 * input, shown only when the mode differed from `prompt`; the model, effort
 * and working directory lived on a separate status line one blank row below
 * the frame. Both are now the same line, directly below the frame: see
 * docs/cli/terminal-design.md#the-composer-footer. This file pins the three
 * states that line can be in, that it never grows past one row doing it, and
 * — since the agent rail moved from between the frame and this footer to
 * below it — that adjacency to the frame, not distance from the bottom of
 * the viewport, is what the footer actually guarantees.
 *
 * Width-pressure drop order (`StatusBar.tsx`'s `fitStatusLine`), earliest
 * dropped first: the shells hint, `esc to interrupt`, the cycle-key
 * reminder, the effort label, the pull request item, the model on the
 * right, and only as a last resort the mode badge itself (truncates, then
 * drops). Hypermode is shown in the message
 * frame, so the footer has no second copy of its label.
 */

import { Box } from 'ink'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { ComposerFrame } from '../ComposerFrame.js'
import { StatusBar } from '../StatusBar.js'
import { lowerRuleRow } from './support/composer-rules.js'
import { type Screen, renderToScreen } from './support/screen.js'

const ROWS = 24

/**
 * A stand-in message frame followed immediately by the footer, exactly the
 * shape App.tsx produces. Unlike the old `bottomPinned` harness this claims
 * no particular terminal height and pins nothing to the viewport's last row
 * — Ink draws it starting at the top, and the assertions below locate the
 * frame's own bottom border rather than assuming it lands at any fixed row.
 */
function belowMessageFrame(footer: ReactElement) {
	return (
		<Box flexDirection="column">
			<ComposerFrame focus={false}>
				<Box height={1} />
			</ComposerFrame>
			{footer}
		</Box>
	)
}

/**
 * The row directly under the message frame's bottom border — the one and
 * only place the footer is allowed to draw. Fails loudly if the border
 * itself cannot be found, rather than silently comparing against `''`.
 */
function footerRow(screen: Screen): string {
	const viewport = screen.viewport()
	const border = lowerRuleRow(viewport)
	expect(border, 'lower rule of the composer not found on screen').toBeGreaterThanOrEqual(0)
	return viewport[border + 1] ?? ''
}

/** The row after the footer's own — blank unless something else follows it. */
function rowAfterFooter(screen: Screen): string {
	const viewport = screen.viewport()
	const border = lowerRuleRow(viewport)
	return viewport[border + 2] ?? ''
}

const noSpecialMode = <StatusBar provider="a-provider" model="gpt-5.6-terra" state="idle" />
const autoMode = (
	<StatusBar
		provider="a-provider"
		model="gpt-5.6-terra"
		state="idle"
		permissionMode="auto"
		canCycleMode
	/>
)
const planWithEffort = (
	<StatusBar
		provider="a-provider"
		model="gpt-5.6-terra"
		effort="high"
		state="idle"
		permissionMode="plan"
		canCycleMode
	/>
)
const planNoEffort = (
	<StatusBar
		provider="a-provider"
		model="gpt-5.6-terra"
		state="idle"
		permissionMode="plan"
		canCycleMode
	/>
)

describe('the composer footer at 80 columns', () => {
	it('shows the quiet cycle reminder and the model when no special mode is active', async () => {
		const screen = await renderToScreen(belowMessageFrame(noSpecialMode), { cols: 80, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row).toContain('shift+tab to cycle')
			expect(row.trimEnd()).toMatch(/gpt-5\.6-terra$/)
			expect(row).not.toContain('⏵⏵')
			expect(row).not.toContain('‖')
			expect(row).not.toContain('effort')
		} finally {
			await screen.unmount()
		}
	})

	it('shows the bypass badge with its cycle key and the model', async () => {
		const screen = await renderToScreen(belowMessageFrame(autoMode), { cols: 80, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row).toContain('⏵⏵ bypass permissions on (shift+tab to cycle)')
			expect(row.trimEnd()).toMatch(/gpt-5\.6-terra$/)
		} finally {
			await screen.unmount()
		}
	})

	it('shows the plan badge with its effort beside it and the model', async () => {
		const screen = await renderToScreen(belowMessageFrame(planWithEffort), { cols: 80, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row).toContain('‖ plan mode on (shift+tab to cycle) · effort high')
			expect(row.trimEnd()).toMatch(/gpt-5\.6-terra$/)
		} finally {
			await screen.unmount()
		}
	})
})

describe('the composer footer at 40 columns', () => {
	it('keeps the quiet reminder and the model when no special mode is active', async () => {
		const screen = await renderToScreen(belowMessageFrame(noSpecialMode), { cols: 40, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row).toContain('shift+tab to cycle')
			expect(row).toContain('gpt-5.6-terra')
		} finally {
			await screen.unmount()
		}
	})

	it('drops the cycle-key reminder before the badge itself shortens', async () => {
		const screen = await renderToScreen(belowMessageFrame(autoMode), { cols: 40, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row, 'the badge was truncated before its cheaper neighbors were dropped').toContain(
				'⏵⏵ bypass permissions on',
			)
			expect(row).not.toContain('shift+tab to cycle')
		} finally {
			await screen.unmount()
		}
	})

	it('keeps the mode badge whole even once the model is dropped for room', async () => {
		const screen = await renderToScreen(belowMessageFrame(planWithEffort), { cols: 40, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row).toContain('‖ plan mode on')
		} finally {
			await screen.unmount()
		}
	})
})

describe('the composer footer under width pressure', () => {
	it('keeps the full mode, effort, path and model when they fit', async () => {
		const screen = await renderToScreen(belowMessageFrame(planWithEffort), {
			cols: 100,
			rows: ROWS,
		})
		try {
			const row = footerRow(screen)
			expect(row).toContain('‖ plan mode on (shift+tab to cycle) · effort high')
			expect(row.trimEnd()).toMatch(/gpt-5\.6-terra$/)
		} finally {
			await screen.unmount()
		}
	})

	it('drops the effort label before the mode badge', async () => {
		// The model identity is the first thing to go, so the effort label only
		// has to give way once the mode and it no longer fit together.
		const screen = await renderToScreen(belowMessageFrame(planWithEffort), {
			cols: 28,
			rows: ROWS,
		})
		try {
			const row = footerRow(screen)
			expect(row).toContain('‖ plan mode on')
			expect(row).not.toContain('effort')
		} finally {
			await screen.unmount()
		}
	})

	it('keeps the mode badge whole at 24 columns', async () => {
		const screen = await renderToScreen(belowMessageFrame(planNoEffort), { cols: 24, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row.trim()).toBe('‖ plan mode on')
		} finally {
			await screen.unmount()
		}
	})
})

describe('the composer footer never grows past one line', () => {
	it.each([20, 30, 40, 60, 80, 120])(
		'stays alone directly under the frame at %d columns',
		async (cols) => {
			const screen = await renderToScreen(belowMessageFrame(planWithEffort), { cols, rows: ROWS })
			try {
				expect(footerRow(screen).length).toBeLessThanOrEqual(cols)
				expect(rowAfterFooter(screen), 'a non-blank row here means the footer wrapped').toBe('')
			} finally {
				await screen.unmount()
			}
		},
	)
})

describe('the footer sits directly under the frame, not at a fixed screen row', () => {
	it('stays adjacent to the frame however much room the viewport has below it', async () => {
		// A generous viewport with nothing pinning content to its bottom: the
		// old harness would have left this test looking at blank rows. The
		// footer must still be found immediately under the frame's border.
		const screen = await renderToScreen(belowMessageFrame(autoMode), { cols: 80, rows: 40 })
		try {
			expect(footerRow(screen)).toContain('⏵⏵ bypass permissions on')
		} finally {
			await screen.unmount()
		}
	})
})
