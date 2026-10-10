import type { TerminalAttachView } from '../shared/terminal-view.js'

/** The part of the emulator a snapshot needs. */
export interface SnapshotTarget {
	cols: number
	rows: number
	reset(): void
	resize(cols: number, rows: number): void
	write(data: string): void
}

/**
 * Draw a host snapshot into a view's emulator.
 *
 * The emulator is first given the size the host's screen had. The snapshot's cursor and line wraps
 * are only right at that size, and a program that redraws on the next resize (Windows' console does,
 * for the first prompt) moves the cursor relative to where it thinks it is. Writing at the view's own
 * width instead left the cursor one cell off, so the first command overwrote the prompt's ">". The
 * caller fits the view afterwards, which makes the emulator reflow exactly as the host's did.
 */
export function applySnapshot(
	term: SnapshotTarget,
	result: Pick<TerminalAttachView, 'screen' | 'data' | 'cols' | 'rows'>,
): void {
	term.reset()
	if (
		result.cols !== undefined &&
		result.rows !== undefined &&
		(term.cols !== result.cols || term.rows !== result.rows)
	)
		term.resize(result.cols, result.rows)
	term.write(result.screen + result.data)
}
