/**
 * The detailed transcript screen: which rows it shows and what its footer says.
 *
 * Pure functions, so the window rule, the divider and the footer line can be
 * driven without a terminal. `TranscriptScreen.tsx` draws what these return.
 */

import type { TranscriptMessage } from './types.js'

/** Rows the screen shows before the person asks for all of them. */
export const TRANSCRIPT_SCREEN_TAIL = 30

/** The rows to draw, and how many older ones the window leaves out. */
export interface ScreenWindow {
	readonly hiddenCount: number
	readonly shown: readonly TranscriptMessage[]
}

/** The last {@link TRANSCRIPT_SCREEN_TAIL} rows, or every row once `showAll` is on. */
export function screenWindow(
	messages: readonly TranscriptMessage[],
	showAll: boolean,
): ScreenWindow {
	if (showAll || messages.length <= TRANSCRIPT_SCREEN_TAIL) {
		return {
			hiddenCount: showAll ? Math.max(0, messages.length - TRANSCRIPT_SCREEN_TAIL) : 0,
			shown: messages,
		}
	}
	return {
		hiddenCount: messages.length - TRANSCRIPT_SCREEN_TAIL,
		shown: messages.slice(-TRANSCRIPT_SCREEN_TAIL),
	}
}

/**
 * The divider above the window: `[before, count, after]`, where `count` is drawn
 * bold. Null when the conversation fits and there is nothing to show or hide.
 */
export function screenDivider(
	hiddenCount: number,
	showAll: boolean,
): readonly [string, string, string] | null {
	if (hiddenCount <= 0) return null
	const noun = hiddenCount === 1 ? 'message' : 'messages'
	return [
		showAll ? 'ctrl+e to hide ' : 'ctrl+e to show ',
		hiddenCount.toLocaleString('en-US'),
		` previous ${noun}`,
	]
}

/** The footer line's left side, cut to `columns` with an ellipsis. */
export function screenFooter(options: {
	readonly showAll: boolean
	readonly dialogWaiting: boolean
	readonly columns: number
}): { readonly prefix: string; readonly text: string } {
	const prefix = options.dialogWaiting ? 'dialog waiting · ' : ''
	const full = `Showing detailed transcript · ctrl+o to toggle · ctrl+e to ${options.showAll ? 'collapse' : 'show all'}`
	const room = Math.max(1, options.columns - prefix.length)
	const text = full.length <= room ? full : `${full.slice(0, Math.max(0, room - 1))}…`
	return { prefix, text }
}
