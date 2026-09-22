/**
 * The status bar sits directly under the message frame's bottom border, and
 * occupies exactly one row there.
 *
 * This file used to pin the bar to the LAST row of the viewport, back when
 * nothing could ever follow it. That stopped being true once the agent rail
 * moved from between the frame and the footer to below it: a live rail (or a
 * child transcript, or the tool-output viewer) now draws beneath this line,
 * so "the bottom row" is no longer a claim the footer can make. What never
 * changed is its distance from the frame above it — always zero rows — and
 * that is the invariant this file pins instead.
 *
 * `status-bar-keeps-the-hint.test.tsx` establishes that the hint SURVIVES a
 * realistic path, by asking whether the frame string contains `Ctrl+C`. That
 * question has an answer whether the bar sits right under the frame or ten
 * rows below it — a frame string has no row geometry, so "directly under the
 * frame" is not a thing it can be asked about at all. Both files stay: this
 * one does not replace that claim, it adds the one that needed a screen.
 *
 * The bar truncates to fit its width. If truncation ever failed, the line
 * would wrap onto a second row — and every `toContain` assertion in the other
 * file would still pass, because the text is all still there. Here it fails,
 * because the row after it is required to stay empty.
 */

import { Box, Text } from 'ink'
import { describe, expect, it } from 'vitest'

import { ComposerFrame } from '../ComposerFrame.js'
import { StatusBar } from '../StatusBar.js'
import { type Screen, renderToScreen } from './support/screen.js'

/** The picker's first-run hint: the only place its exits are named. */
const HINT = '↑↓ navigate · enter accept · esc or Ctrl+C exit'

/** Deep but unremarkable — a service inside a monorepo inside a work folder. */
const DEEP_CWD =
	'/home/dev/work/acme-platform/services/payments-api/packages/core'

const COLS = 100
const ROWS = 24

/**
 * A stand-in message frame with the footer directly beneath it, exactly the
 * shape App.tsx produces below the transcript. This harness claims no
 * particular terminal height and pins nothing to the viewport's last row —
 * what is under test is what the footer does relative to the frame above it,
 * not relative to a viewport edge that a live rail can now sit past.
 */
function belowMessageFrame(cwd: string) {
	return (
		<Box flexDirection="column">
			<ComposerFrame focus={false}>
				<Box height={1} />
			</ComposerFrame>
			<StatusBar
				cwd={cwd}
				provider="acme-personal (acme)"
				model="model-of-the-day"
				state="idle"
				hint={HINT}
			/>
		</Box>
	)
}

/** The message frame's bottom border row, found wherever the layout put it. */
function frameBottomBorder(screen: Screen): number {
	const viewport = screen.viewport()
	const border = viewport.findIndex((line) => line.includes('└') && line.includes('┘'))
	expect(border, 'message frame bottom border not found on screen').toBeGreaterThanOrEqual(0)
	return border
}

describe('the status bar directly under the message frame', () => {
	it('puts the mode, effort and cwd on the left and the durable goal on the right', async () => {
		const screen = await renderToScreen(
			<Box flexDirection="column">
				<ComposerFrame focus={false}>
					<Box height={1} />
				</ComposerFrame>
				<StatusBar
					cwd="/home/dev/work/namzu"
					provider="OpenAI (Codex subscription)"
					model="gpt-5.6-sol"
					effort="xhigh"
					goal="Goal stalled (/goal resume)"
					state="idle"
					permissionMode="plan"
					canCycleMode
				/>
			</Box>,
			{ cols: COLS, rows: ROWS },
		)
		try {
			const viewport = screen.viewport()
			const row = viewport[frameBottomBorder(screen) + 1] ?? ''
			expect(row).toContain('‖ Plan (read-only) (shift+tab to cycle) · effort xhigh · ')
			expect(row).toContain('work/namzu')
			expect(row.trimEnd()).toMatch(/Goal stalled \(\/goal resume\)$/)
			expect(row).not.toContain('Codex subscription')
			// The goal wins the right-hand slot over the model, exactly as it won
			// it over the path before the model moved to this side.
			expect(row).not.toContain('gpt-5.6-sol')
		} finally {
			await screen.unmount()
		}
	})

	it('draws directly under the frame, whatever room the viewport leaves below it', async () => {
		const screen = await renderToScreen(belowMessageFrame(DEEP_CWD), {
			cols: COLS,
			rows: ROWS,
		})
		try {
			const viewport = screen.viewport()
			const border = frameBottomBorder(screen)
			expect(viewport[border + 1]).toContain('Ctrl+C')
			expect(viewport[border + 1]).not.toContain('idle')
		} finally {
			await screen.unmount()
		}
	})

	it('occupies one row, so the row after it stays empty here', async () => {
		const screen = await renderToScreen(belowMessageFrame(DEEP_CWD), {
			cols: COLS,
			rows: ROWS,
		})
		try {
			const viewport = screen.viewport()
			const border = frameBottomBorder(screen)
			const row = viewport[border + 1] ?? ''
			// The claim the other file cannot make. A bar that wrapped would put
			// its overflow here, and every substring assertion over there would
			// still pass, because the text is all still there.
			expect(viewport[border + 2], 'a second row means the footer wrapped').toBe('')
			// And the bar is really as wide as the terminal, not a short line
			// that happens to fit — otherwise "it truncates" is untested.
			expect(row.length).toBeGreaterThan(COLS / 2)
			expect(row.length).toBeLessThanOrEqual(COLS)
		} finally {
			await screen.unmount()
		}
	})

	it('leaves the transcript in the operator’s scrollback', async () => {
		const screen = await renderToScreen(belowMessageFrame('/w'), {
			cols: COLS,
			rows: ROWS,
		})
		try {
			// An app that took the alternate screen would draw identically and
			// leave nothing behind when it exits. Only a screen-level reader can
			// tell those two apart.
			expect(screen.bufferType()).toBe('normal')
		} finally {
			await screen.unmount()
		}
	})

	it('would have said so had it taken the alternate screen', async () => {
		// The assertion above is worth nothing unless this reader can return
		// the other answer, and nothing shipped here drives it to. So it is
		// driven from the harness — the point is the reader, not the app.
		const screen = await renderToScreen(belowMessageFrame('/w'), {
			cols: COLS,
			rows: ROWS,
			alternateScreen: true,
		})
		try {
			expect(screen.bufferType()).toBe('alternate')
		} finally {
			await screen.unmount()
		}
	})
})

describe('the viewport and the scrollback are not the same read', () => {
	it('shows the last rows on screen and keeps the earlier ones behind', async () => {
		// Content taller than the terminal. Without this case `viewport()` and
		// `scrollback()` return the same rows for every test in the suite, and
		// the offset that separates them is decoration.
		const lines = Array.from({ length: ROWS * 2 }, (_, i) => `line-${i}`)
		const screen = await renderToScreen(
			<Box flexDirection="column">
				{lines.map((line) => (
					<Text key={line}>{line}</Text>
				))}
			</Box>,
			{ cols: COLS, rows: ROWS },
		)
		try {
			const visible = screen.viewport()
			const everything = screen.scrollback()

			// The screen holds the tail.
			expect(visible).toContain(`line-${ROWS * 2 - 1}`)
			expect(visible).not.toContain('line-0')
			// The scrollback holds the head, which has left the screen.
			expect(everything).toContain('line-0')
			expect(everything.length).toBeGreaterThan(visible.length)
		} finally {
			await screen.unmount()
		}
	})
})

describe('counting what was written', () => {
	it('writes nothing more when a rerender changes nothing', async () => {
		const screen = await renderToScreen(belowMessageFrame(DEEP_CWD), {
			cols: COLS,
			rows: ROWS,
		})
		try {
			const afterFirstPaint = screen.bytesWritten()
			expect(afterFirstPaint).toBeGreaterThan(0)

			screen.rerender(belowMessageFrame(DEEP_CWD))
			await screen.waitForRender()

			// "It repainted in place" is a description until something counts
			// bytes. An identical frame is not written at all, and this is the
			// reader that can say so — `viewport()` would look the same either
			// way, which is precisely the blind spot.
			expect(screen.bytesWritten()).toBe(afterFirstPaint)

			// The other half, or the assertion above passes against a counter
			// that is simply stuck.
			screen.rerender(belowMessageFrame('/somewhere/else/entirely'))
			await screen.waitForRender()
			expect(screen.bytesWritten()).toBeGreaterThan(afterFirstPaint)
		} finally {
			await screen.unmount()
		}
	})

	it('repaints in place rather than printing the bar again', async () => {
		const screen = await renderToScreen(belowMessageFrame('/a'), {
			cols: COLS,
			rows: ROWS,
		})
		try {
			screen.rerender(belowMessageFrame('/b'))
			await screen.waitForRender()

			// One bar on the screen, not two. A renderer that printed the new
			// frame BELOW the old one would leave both, and the scrollback is
			// where that shows up.
			const drawn = screen
				.scrollback()
				.filter((line) => line.includes('Ctrl+C'))
			expect(drawn.length).toBe(1)
			const viewport = screen.viewport()
			expect(viewport[frameBottomBorder(screen) + 1]).toContain('/b')
		} finally {
			await screen.unmount()
		}
	})
})
