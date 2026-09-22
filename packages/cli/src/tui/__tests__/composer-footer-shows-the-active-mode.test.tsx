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
 * Width-pressure drop order (`StatusBar.tsx`'s `fitStatusLine`), left to
 * right in survival priority — earliest dropped first: the working
 * directory (shrinks, then drops), the effort label, the cycle-key
 * reminder, the model on the right, `orchestrate`, and only as a last
 * resort the mode badge itself (truncates, then drops). `orchestrate` is
 * deliberately NOT bundled with effort — it is a persistent,
 * behavior-changing session setting with no other on-screen indicator, so
 * it holds the badge's own priority tier and outlives effort, the cwd and
 * the model being dropped out from under it. It never forces the badge to
 * shrink to make room for it, and is never itself truncated to a
 * fragment of the word: below the width where it fits whole beside an
 * already-fitted badge, it disappears entirely and the badge wins.
 */

import { Box } from 'ink'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { ComposerFrame } from '../ComposerFrame.js'
import { StatusBar } from '../StatusBar.js'
import { type Screen, renderToScreen } from './support/screen.js'

const CWD = '/home/dev/work/namzu'
const LONG_CWD = '/home/dev/workspaces/really/quite/deeply/nested/project/namzu'
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
const orchestrateNoModeNoEffort = (
	<StatusBar cwd={CWD} provider="a-provider" model="gpt-5.6-terra" orchestrate state="idle" />
)
const orchestrateNoModeWithEffort = (
	<StatusBar cwd={CWD} provider="a-provider" model="gpt-5.6-terra" effort="high" orchestrate state="idle" />
)
const orchestrateWithLongCwd = (
	<StatusBar
		cwd={LONG_CWD}
		provider="a-provider"
		model="gpt-5.6-terra"
		effort="high"
		orchestrate
		state="idle"
		permissionMode="plan"
		canCycleMode
	/>
)
const noOrchestrateWithLongCwd = (
	<StatusBar
		cwd={LONG_CWD}
		provider="a-provider"
		model="gpt-5.6-terra"
		effort="high"
		state="idle"
		permissionMode="plan"
		canCycleMode
	/>
)
const planNoOrchestrateNoEffort = (
	<StatusBar cwd={CWD} provider="a-provider" model="gpt-5.6-terra" state="idle" permissionMode="plan" canCycleMode />
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
			expect(row).not.toContain('‖')
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
			expect(row).toContain('‖ Plan (read-only) (shift+tab to cycle) · effort high')
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
			expect(row).toContain('‖ Plan (read-only)')
		} finally {
			await screen.unmount()
		}
	})
})

describe('orchestrate holds the mode badge own priority under width pressure', () => {
	it('at 100 columns: the whole line is unaffected, in the documented order', async () => {
		const screen = await renderToScreen(belowMessageFrame(orchestrateNoModeWithEffort), {
			cols: 100,
			rows: ROWS,
		})
		try {
			const row = footerRow(screen)
			expect(row).toContain(`shift+tab to cycle · effort high · orchestrate · ${CWD}`)
			expect(row.trimEnd()).toMatch(/gpt-5\.6-terra$/)
		} finally {
			await screen.unmount()
		}
	})

	it('at 60 columns: sheds effort before orchestrate, and keeps the model', async () => {
		const screen = await renderToScreen(belowMessageFrame(planWithOrchestrate), { cols: 60, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row).toContain('‖ Plan (read-only) · orchestrate')
			expect(row).not.toContain('effort')
			expect(row).toContain('gpt-5.6-terra')
		} finally {
			await screen.unmount()
		}
	})

	it('at 40 columns beside the mode badge: cwd, effort and the model are gone, orchestrate is not', async () => {
		const screen = await renderToScreen(belowMessageFrame(planWithOrchestrate), { cols: 40, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row.trimEnd()).toBe('‖ Plan (read-only) · orchestrate')
			expect(row).not.toContain('effort')
			expect(row).not.toContain(CWD)
			expect(row).not.toContain('gpt-5.6-terra')
		} finally {
			await screen.unmount()
		}
	})

	it('at 40 columns beside the quiet reminder (no active mode): same survival, with effort set', async () => {
		const screen = await renderToScreen(belowMessageFrame(orchestrateNoModeWithEffort), { cols: 40, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row.trimEnd()).toBe('shift+tab to cycle · orchestrate')
		} finally {
			await screen.unmount()
		}
	})

	it('at 40 columns beside the quiet reminder, with no effort menu pinned either', async () => {
		const screen = await renderToScreen(belowMessageFrame(orchestrateNoModeNoEffort), { cols: 40, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row.trimEnd()).toBe('shift+tab to cycle · orchestrate')
		} finally {
			await screen.unmount()
		}
	})

	it('at 40 columns, orchestrate off: the earlier drop order is unaffected', async () => {
		const screen = await renderToScreen(belowMessageFrame(planNoOrchestrateNoEffort), { cols: 40, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row).not.toContain('orchestrate')
			expect(row).toContain('‖ Plan (read-only)')
		} finally {
			await screen.unmount()
		}
	})

	it('survives a long working directory: cwd is dropped, orchestrate is not', async () => {
		const screen = await renderToScreen(belowMessageFrame(orchestrateWithLongCwd), { cols: 40, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row.trimEnd()).toBe('‖ Plan (read-only) · orchestrate')
			expect(row).not.toContain('nested')
		} finally {
			await screen.unmount()
		}
	})

	it('a long cwd drops the same way whether or not orchestrate is on', async () => {
		const screen = await renderToScreen(belowMessageFrame(noOrchestrateWithLongCwd), { cols: 40, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row).not.toContain('nested')
			expect(row).not.toContain('orchestrate')
		} finally {
			await screen.unmount()
		}
	})

	it('below the width where "orchestrate" fits whole beside an already-fitted badge, the badge wins', async () => {
		// 24 columns: `fitStatusLine` sees 22 after StatusBar's own 2-cell
		// padding — room for "‖ Plan (read-only)" (18) whole, but not for
		// " · orchestrate" (14 more) beside it. Orchestrate is dropped
		// entirely rather than truncated to a fragment of the word, and the
		// badge is not shortened to make room for it either.
		const screen = await renderToScreen(belowMessageFrame(orchestrateWithNoEffortMenu), { cols: 24, rows: ROWS })
		try {
			const row = footerRow(screen)
			expect(row.trimEnd()).toBe('‖ Plan (read-only)')
			expect(row).not.toContain('orchestrate')
			expect(row).not.toContain('orchestra')
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
