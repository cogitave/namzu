/**
 * Keeps the live region shorter than the terminal.
 *
 * ## Why the live region must never reach the terminal's height
 *
 * Ink 7 repaints the live region in place only while it is shorter than the
 * viewport. Once a frame reaches the viewport's height it switches to a
 * different path: it writes `clearTerminal`, then every line of static output
 * it has kept this session, then the frame. On a long session that is the whole
 * transcript again, on every frame the reply grows by.
 *
 * That path also loses a row. When the frame that leaves it is shorter than
 * the viewport again, Ink writes the frame without its trailing newline but
 * records the frame as if the newline had been written (`ink.js`,
 * `renderInteractiveFrame`: it writes `output` and syncs `outputToRender`). The
 * next frame then erases one row more than the live region holds, and that row
 * is the last one already handed to scrollback: at the end of a long reply,
 * its final line. A real terminal showed it on both 80 and 160 columns.
 *
 * The live window (`live-window.ts`) bounds the FINALIZED rows it keeps
 * redrawable, but a streaming reply is drawn whole, and a table, a long answer
 * or a tall picker can take the live region past the viewport by itself. This
 * box caps the region one row short of the viewport and anchors it to the
 * bottom, so the newest rows — the reply as it arrives, the composer, the
 * status bar — stay on screen and the top of the region is what gives way.
 * Nothing is lost by that: the part cut off is what the terminal would have
 * scrolled above the viewport anyway, and when the reply finishes it is printed
 * to scrollback whole.
 *
 * `<Static>` inside it is unaffected: Ink lays static output out on its own
 * and prints it outside the live frame, so the cap never clips scrollback.
 */

import { Box } from 'ink'
import type { ReactNode } from 'react'

/**
 * The most rows the live region may take on a terminal `rows` high.
 *
 * `undefined` — no cap — when the height is not known or too small to mean
 * anything, which is what a non-TTY stdout reports.
 */
export function liveRegionCap(rows: number | undefined): number | undefined {
	if (rows === undefined || !Number.isFinite(rows) || rows < 3) return undefined
	return Math.floor(rows) - 1
}

export interface ViewportBoundProps {
	/** Terminal height. */
	readonly rows: number | undefined
	readonly display?: 'flex' | 'none'
	readonly children: ReactNode
}

export function ViewportBound({ rows, display = 'flex', children }: ViewportBoundProps) {
	const cap = liveRegionCap(rows)
	if (cap === undefined) {
		return (
			<Box flexDirection="column" display={display}>
				{children}
			</Box>
		)
	}
	// `flex-end` over a content box that may not shrink: taller content spills
	// out of the top, where `overflowY` clips it, rather than being squeezed.
	return (
		<Box
			flexDirection="column"
			display={display}
			maxHeight={cap}
			overflowY="hidden"
			justifyContent="flex-end"
		>
			<Box flexDirection="column" flexShrink={0}>
				{children}
			</Box>
		</Box>
	)
}
