/**
 * The detailed transcript screen: which rows it shows and what its footer says.
 *
 * Pure functions, so the window rule, the divider and the footer line can be
 * driven without a terminal. `TranscriptScreen.tsx` draws what these return.
 */

import type { TranscriptMessage } from './types.js'

/** Rows the screen shows before the person asks for all of them, once the conversation is longer than {@link TRANSCRIPT_SCREEN_WHOLE}. */
export const TRANSCRIPT_SCREEN_TAIL = 30

/** A conversation of this many rows or fewer is shown whole from the start. */
export const TRANSCRIPT_SCREEN_WHOLE = 200

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

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * When and by which model a reply was written, as one quiet line: `10:42 · model`, with the date
 * in front when it was not today. Null when the reply carries neither.
 */
export function replyStamp(
	message: Pick<TranscriptMessage, 'role' | 'at' | 'model' | 'pending'>,
	now: number = Date.now(),
): string | null {
	if (message.role !== 'assistant' || message.pending) return null
	const parts: string[] = []
	if (message.at !== undefined) {
		const at = new Date(message.at)
		const today = new Date(now)
		const sameDay =
			at.getFullYear() === today.getFullYear() &&
			at.getMonth() === today.getMonth() &&
			at.getDate() === today.getDate()
		const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
		parts.push(
			sameDay
				? clock
				: `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${clock}`,
		)
	}
	if (message.model) parts.push(message.model)
	return parts.length > 0 ? parts.join(' · ') : null
}

/** The conversation as plain text, for opening in an editor: who said what, whole, with each reply's stamp. */
export function transcriptPlainText(
	messages: readonly TranscriptMessage[],
	now: number = Date.now(),
): string {
	const out: string[] = []
	for (const message of messages) {
		const who =
			message.role === 'user'
				? 'You'
				: message.role === 'assistant'
					? 'Namzu'
					: message.role === 'tool'
						? 'Tool'
						: 'Note'
		if (message.thinking) out.push(`[thinking]\n${message.thinking}`)
		const stamp = replyStamp(message, now)
		const body = [
			message.content,
			...(message.detail ?? []),
			...(message.shell ? [...message.shell.stdout, ...message.shell.stderr] : []),
		].join('\n')
		out.push(`${who}${stamp ? ` (${stamp})` : ''}:\n${body}`)
	}
	return `${out.join('\n\n')}\n`
}
