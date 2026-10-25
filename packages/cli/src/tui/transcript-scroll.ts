/**
 * The scrollable transcript view: rows, follow state and the one-line hint.
 *
 * The conversation itself goes to the terminal's own scrollback and stays
 * there. This view is the opt-in alternative for an operator who wants to page
 * back through it inside the app: a full-height box in the live region (not
 * the alternate screen) that shows a window of the same rows.
 *
 * The state is deliberately small. The view only exists while the operator is
 * reading older rows, so "following the latest" is the absence of the view:
 * reaching the bottom, or asking for it, closes it. Everything here is a pure
 * function so the behaviour can be driven without a terminal or a clock.
 */

import { renderedDetailLines } from './Transcript.js'
import { contentColorForRole, glyphColorForRole, glyphForRole } from './Transcript.js'
import { choiceDisplayWidth, wrapChoiceText } from './terminal-choice-text.js'
import { terminalDisplayText } from './terminal-display.js'
import { paint, theme } from './theme.js'
import type { TranscriptMessage } from './types.js'

/** One physical row of the scroll view. */
export interface ScrollRow {
	readonly glyph: string
	readonly glyphColor: string
	readonly text: string
	readonly color: string
}

/** Columns the glyph gutter takes, as in the live transcript. */
const GUTTER = 2

/**
 * The rows the view shows, oldest first.
 *
 * Messages are laid out the way the live transcript lays them out: a glyph
 * gutter with the text hanging under it, one blank row between entries, and a
 * `⎿` result hugging the call above it. Reply text is shown as written rather
 * than rendered as Markdown, so the row count never depends on a parser.
 */
export function transcriptScrollRows(
	messages: readonly TranscriptMessage[],
	pending: TranscriptMessage | null,
	pendingAt: number | undefined,
	columns: number,
): readonly ScrollRow[] {
	const at = Math.min(Math.max(pendingAt ?? messages.length, 0), messages.length)
	const ordered = pending ? [...messages.slice(0, at), pending, ...messages.slice(at)] : messages
	const width = Math.max(4, Math.floor(columns) - GUTTER)
	const rows: ScrollRow[] = []
	ordered.forEach((message, index) => {
		const prev = index > 0 ? ordered[index - 1] : undefined
		const glyph = message.glyph ?? glyphForRole(message.role)
		const glyphColor =
			paint(message.glyphColor) ?? (glyph === '⎿' ? theme.text.muted : glyphColorForRole(message.role))
		const color = paint(message.contentColor) ?? contentColorForRole(message.role)
		const joined = message.statusRows
			? message.statusRows.map(([label, value]) => `${label}  ${value}`).join('\n')
			: `${message.content.length > 0 ? message.content : message.pending ? '…' : ''}${
					message.meta ? ` · ${terminalDisplayText(message.meta)}` : ''
				}`
		const body = wrapChoiceText(joined, width)
		const detail = message.statusRows
			? []
			: renderedDetailLines(message).flatMap((line) =>
					wrapChoiceText(line.length > 0 ? line : ' ', width + GUTTER).map((part) => part),
				)
		const gap = !prev || glyph === '⎿' ? 0 : 1
		if (rows.length > 0 && gap === 1) rows.push({ glyph: ' ', glyphColor, text: '', color })
		body.forEach((text, i) => {
			rows.push({ glyph: i === 0 ? glyph : ' ', glyphColor, text, color })
		})
		for (const text of detail) {
			rows.push({
				glyph: ' ',
				glyphColor,
				text: text.trimStart() ? text : '',
				color: theme.text.muted,
			})
		}
	})
	return rows
}

/** Where the view sits. `top` is the first visible row. */
export interface ScrollState {
	readonly top: number
	/** New output arrived below the window since the operator last saw the end. */
	readonly unseen: boolean
	/** What the end of the transcript looked like when `unseen` was last decided. */
	readonly signature: string
}

/** Outcome of an input: stay in the view at a new position, or return to the latest. */
export type ScrollResult = ScrollState | 'latest'

export type ScrollMove = 'page-up' | 'page-down' | 'line-up' | 'line-down' | 'top' | 'bottom'

/** The first row of the last page: the highest `top` that still shows the end. */
export function lastTop(total: number, height: number): number {
	return Math.max(0, total - height)
}

/** A cheap fingerprint of the end of the transcript, so a change can be told from none. */
export function endSignature(rows: readonly ScrollRow[]): string {
	const last = rows.at(-1)
	return `${rows.length}:${last?.text ?? ''}`
}

/**
 * Open the view one page above the end, or decline when everything already fits
 * (there is nothing above to read, and the terminal's own scrollback has it).
 */
export function openScroll(rows: readonly ScrollRow[], height: number): ScrollState | null {
	const total = rows.length
	if (total <= height) return null
	return {
		top: Math.max(0, lastTop(total, height) - pageSize(height)),
		unseen: false,
		signature: endSignature(rows),
	}
}

/** A page is one row less than the window, so the row at the edge stays in view. */
export function pageSize(height: number): number {
	return Math.max(1, height - 1)
}

/**
 * Apply a movement. Moving down to or past the last page resumes following on
 * its own, which closes the view; there is no separate "stay at the bottom".
 */
export function moveScroll(
	state: ScrollState,
	move: ScrollMove,
	total: number,
	height: number,
): ScrollResult {
	const max = lastTop(total, height)
	const page = pageSize(height)
	let top = state.top
	switch (move) {
		case 'page-up':
			top -= page
			break
		case 'page-down':
			top += page
			break
		case 'line-up':
			top -= 1
			break
		case 'line-down':
			top += 1
			break
		case 'top':
			top = 0
			break
		case 'bottom':
			return 'latest'
	}
	if (top >= max) return 'latest'
	return { ...state, top: Math.max(0, top) }
}

/**
 * Reconcile the view with the transcript as it is now. Called whenever the
 * rows change.
 *
 * The window does not move when output arrives: it is anchored to the row it
 * shows, so what is being read stays put. New output below sets `unseen` (a
 * flag, not a count); the end coming into view clears it, and being at the end
 * is the same as following, so the view closes.
 */
export function syncScroll(
	state: ScrollState,
	rows: readonly ScrollRow[],
	height: number,
): ScrollResult {
	const total = rows.length
	const max = lastTop(total, height)
	if (state.top >= max) return 'latest'
	const signature = endSignature(rows)
	return {
		top: state.top,
		unseen: state.unseen || signature !== state.signature,
		signature,
	}
}

const HINT_IDLE = ['↓ Back to bottom · esc', '↓ Bottom · esc', '↓ Bottom', '↓'] as const
const HINT_UNSEEN = [
	'New activity · ↓ Back to bottom · esc',
	'New activity · ↓ Bottom · esc',
	'New · ↓ Bottom',
	'↓ Bottom',
	'↓',
] as const

/**
 * The single hint row above the composer: the first label that fits, so it
 * shortens before it ever wraps. Null only when not even the arrow fits.
 */
export function followHint(columns: number, unseen: boolean): string | null {
	const ladder = unseen ? HINT_UNSEEN : HINT_IDLE
	return ladder.find((label) => choiceDisplayWidth(label) <= columns) ?? null
}
