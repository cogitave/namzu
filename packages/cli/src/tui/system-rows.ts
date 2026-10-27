/**
 * How the transcript's system rows look, in one place.
 *
 * Every row the app writes about itself (a hook said something, the provider
 * changed, a reply was paused, a job ended) used to pick its own gutter glyph,
 * so the margin collected a dozen symbols that nothing explained. Now
 * there is one: a coloured dot, with a `⎿` line for anything
 * that continues it. The level says how much the person should care; the
 * words say what happened.
 *
 * `✻` is not in this table on purpose. It belongs to exactly two rows, the
 * line that closes a reply and the line that says the conversation was
 * compacted, and nothing else may borrow it.
 */

import { tokenColor } from './theme.js'

/** How much a system row asks of the reader. */
export type SystemLevel = 'notice' | 'warning' | 'error'

/** The gutter glyph of every system row that is not one of the two `✻` lines. */
export const SYSTEM_ROW_GLYPH = '●'
/** The gutter glyph of a line that continues the row above it. */
export const CONTINUATION_GLYPH = '⎿'
/**
 * The one gutter every tool result hangs from, shell output and one-line
 * results alike: two columns of indent, the `⎿`, then two spaces
 * (`  ⎿  `).
 */
export const RESULT_GUTTER_INDENT = 2
/** Width of the `⎿` plus the two spaces after it. */
export const RESULT_GUTTER_WIDTH = 3

/** The gutter glyph of the away recap row. It belongs to that row only. */
export const RECAP_GLYPH = '※'
/** The label before the text of an away recap. */
export const RECAP_LABEL = 'recap:'

/** The gutter glyph of the reply-closing line and of the compaction line. */
export const CLOSING_GLYPH = '✻'

export interface SystemRowStyle {
	readonly glyph: string
	readonly color: string
}

/** The one level to glyph and colour mapping: warning yellow, notice dim, error red. */
export function systemRowStyle(level: SystemLevel): SystemRowStyle {
	switch (level) {
		case 'warning':
			return { glyph: SYSTEM_ROW_GLYPH, color: tokenColor('status.warn') }
		case 'error':
			return { glyph: SYSTEM_ROW_GLYPH, color: tokenColor('status.error') }
		case 'notice':
			return { glyph: SYSTEM_ROW_GLYPH, color: tokenColor('text.muted') }
	}
}

/** The text of an interruption. */
export const INTERRUPTED_TEXT = 'Interrupted · What should Namzu do instead?'
/** After a send-now steer the next instruction is already on its way, so no question. */
export const INTERRUPTED_BY_STEER_TEXT = 'Interrupted'
/** A command that was running carries on as a background job instead of stopping. */
export const INTERRUPTED_COMMAND_CONTINUES_TEXT =
	'Interrupted · The command continues in the background'

export interface InterruptionRow {
	readonly content: string
	readonly glyph: string
	readonly color: string
}

/**
 * The row an interruption leaves behind.
 *
 * With a call in flight it hangs under that call as a `⎿` line, the way the
 * call's own result would; with none it stands alone as a dim notice. A
 * send-now steer drops the question, because the answer to it is already
 * being sent.
 */
export function interruptionRow(options: {
	readonly callRunning: boolean
	readonly steered?: boolean
	readonly movedToBackground?: boolean
}): InterruptionRow {
	const content =
		options.movedToBackground === true
			? INTERRUPTED_COMMAND_CONTINUES_TEXT
			: options.steered === true
				? INTERRUPTED_BY_STEER_TEXT
				: INTERRUPTED_TEXT
	return options.callRunning
		? { content, glyph: CONTINUATION_GLYPH, color: tokenColor('text.muted') }
		: { content, ...systemRowStyle('notice') }
}

/** How an agent, a workflow or a background job came to an end. */
export type EndOutcome = 'finished' | 'failed' | 'stopped'

/**
 * The one word per outcome, used by agents, workflows and background jobs
 * alike. Three states are all the person acts on: it worked, it did not, or
 * somebody stopped it.
 */
export const END_WORDS: Readonly<Record<EndOutcome, string>> = {
	finished: 'finished',
	failed: 'failed',
	stopped: 'stopped',
}

/**
 * Which outcome a status from the runtime is. Anything it does not recognise
 * reads as finished rather than printing the raw status: the raw word is an
 * enum for the code, and the person cannot do anything with `exited` or
 * `completed` that `finished` does not already tell them.
 */
export function endOutcome(status: string | undefined): EndOutcome {
	switch (status) {
		case 'failed':
		case 'error':
		case 'errored':
		case 'timeout':
		case 'timed_out':
			return 'failed'
		case 'stopped':
		case 'killed':
		case 'cancelled':
		case 'canceled':
		case 'aborted':
		case 'interrupted':
			return 'stopped'
		default:
			return 'finished'
	}
}

/** The word for a runtime status, through {@link endOutcome} and {@link END_WORDS}. */
export function endWord(status: string | undefined): string {
	return END_WORDS[endOutcome(status)]
}

/** The level a finished, failed or stopped thing is drawn at. */
export function endLevel(outcome: EndOutcome): SystemLevel {
	return outcome === 'failed' ? 'error' : outcome === 'stopped' ? 'warning' : 'notice'
}

/** `Goal, attempt 2 of 5`: the headline of a goal round, with the objective on a `⎿` line. */
export function goalRoundHeadline(round: number, max: number): string {
	return `Goal, attempt ${round} of ${max}`
}

/**
 * The notice after a copy request goes out. The terminal never confirms a
 * clipboard write, so this says what was sent, in a short form,
 * and what to do if the paste comes up empty.
 */
export function clipboardSentNotice(chars: number, what?: string): string {
	const count = `${chars.toLocaleString('en-US')} char${chars === 1 ? '' : 's'}`
	return `Sent ${count}${what ? ` (${what})` : ''} via OSC 52 · if paste fails, allow clipboard access in your terminal`
}
