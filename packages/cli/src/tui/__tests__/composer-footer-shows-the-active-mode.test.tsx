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
 */

import { Box } from 'ink'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { ComposerFrame } from '../ComposerFrame.js'
import { StatusBar } from '../StatusBar.js'
import { type Screen, renderToScreen } from './support/screen.js'

const CWD = '/home/dev/work/namzu'
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
	const border = viewport.findIndex((line) => line.includes('└') && line.includes('┘'))
	expect(border, 'message frame bottom border not found on screen').toBeGreaterThanOrEqual(0)
	return viewport[border + 1] ?? ''
}

/** The row after the footer's own — blank unless something else follows it. */
function rowAfterFooter(screen: Screen): string {
	const viewport = screen.viewport()
	const border = viewport.findIndex((line) => line.includes('└') && line.includes('┘'))
	return viewport[border + 2] ?? ''
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
const planWithOrchestrate = (
	<StatusBar
		cwd={CWD}
		provider="a-provider"
		model="gpt-5.6-terra"
		effort="high"
		orchestrate
		state="idle"
		permissionMode="plan"
		canCycleMode
	/>
)
const orchestrateWithNoEffortMenu = (
	<StatusBar
		cwd={CWD}
		provider="a-provider"
		model="gpt-5.6-terra"
		orchestrate
		state="idle"
		permissionMode="plan"
		canCycleMode
	/>
)

describe('the composer footer at 80 columns', () => {
	it('shows the quiet cycle reminder, the cwd and the model when no special mode is active', async () => {
		const screen = await renderToScreen(belowMessageFrame(noSpecialMode), { cols: 80, rows: ROWS })
		try {
			const row = footerRow(screen)
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
		const screen = await renderToScreen(belowMessageFrame(autoMode), { cols: 80, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row).toContain('⏵⏵ Auto-approve tools (shift+tab to cycle)')
			expect(row).toContain('work/namzu')
			expect(row.trimEnd()).toMatch(/gpt-5\.6-terra$/)
		} finally {
			await screen.unmount()
		}
	})

	it('shows the plan badge with its effort beside it and the model', async () => {
		const screen = await renderToScreen(belowMessageFrame(planWithEffort), { cols: 80, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row).toContain('⏸ Plan (read-only) (shift+tab to cycle) · effort high')
			expect(row.trimEnd()).toMatch(/gpt-5\.6-terra$/)
		} finally {
			await screen.unmount()
		}
	})

	it('reads the level and the mode side by side, not as a sixth level', async () => {
		// A wider column than its neighbours above: "· effort high · orchestrate"
		// is exactly the longer string this test exists to check, and it needs
		// the room those shorter fixtures did not.
		const screen = await renderToScreen(belowMessageFrame(planWithOrchestrate), {
			cols: 100,
			rows: ROWS,
		})
		try {
			const row = footerRow(screen)
			expect(row).toContain('· effort high · orchestrate')
		} finally {
			await screen.unmount()
		}
	})

	it('names orchestrate alone, never as a fabricated effort value, when no menu is pinned', async () => {
		const screen = await renderToScreen(belowMessageFrame(orchestrateWithNoEffortMenu), {
			cols: 80,
			rows: ROWS,
		})
		try {
			const row = footerRow(screen)
			expect(row).toContain('· orchestrate')
			expect(row).not.toContain('effort orchestrate')
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
				'⏵⏵ Auto-approve tools',
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
			expect(row).toContain('⏸ Plan (read-only)')
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
			expect(footerRow(screen)).toContain('⏵⏵ Auto-approve tools')
		} finally {
			await screen.unmount()
		}
	})
})
