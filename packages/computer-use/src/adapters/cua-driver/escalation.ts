import type { ActionDelivery, ActionRetrySafety } from '@namzu/sdk'
import { type Observation, type ObservedVerdict, isCut, sameObservation } from './observe.js'

/**
 * When an input that could not be confirmed is tried again, and when it must not be.
 *
 * A background input the driver cannot confirm is judged by reading the window
 * afterwards. There are three honest outcomes besides "the effect was seen":
 *
 * - no effect: the window read the same before and after, on every read over
 *   the wait the effect would take, no window of the program opened, the
 *   control the text went to (where there is one) holds the same text, and the
 *   window was not changing by itself. Nothing the input did is left to undo,
 *   so the same input may be sent again, on the screen;
 * - unexplained: the window changed, but not in a way that shows this input
 *   did it. Sending it again could do it twice, so it is not retried;
 * - unknown: the window could not be read well enough to say either.
 *
 * The retry is made once. After it the answer is final, whatever it is.
 */

/** What the control that took the text read before and after (a classic edit control), when one was read. */
export type EditStill = 'unchanged' | 'changed' | 'unknown'

export interface StillnessReads {
	readonly before: Observation
	/** A read taken just before `before`: unequal reads mean the window was changing by itself. */
	readonly earlier?: Observation
	/** Every read after the input, in order. */
	readonly afters: readonly Observation[]
	/** A new window of the same program appeared. */
	readonly opened: boolean
	readonly edit?: EditStill
}

/** The fewest reads that can show a window holding still. */
export const MIN_STILL_READS = 2

/**
 * What the reads show when no effect of the input was recognised in them: that
 * the input provably did nothing, or that the window changed unexplained.
 * Undefined when the reads cannot tell (too few, nothing to read, a window that
 * changes by itself, a text control that could not be read).
 */
export function judgeStillness(reads: StillnessReads): ObservedVerdict | undefined {
	if (reads.opened || reads.afters.length < MIN_STILL_READS) return undefined
	if (reads.before.size === 0) return undefined
	if (reads.earlier !== undefined && !sameObservation(reads.earlier, reads.before)) return undefined
	if (reads.edit === 'unknown') return undefined
	// A read that left something out (a cut text, a cut walk) cannot show that nothing changed.
	if (isCut(reads.before) || reads.afters.some(isCut)) return undefined
	const moved =
		reads.edit === 'changed' || reads.afters.some((read) => !sameObservation(reads.before, read))
	if (moved)
		return {
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
			outcome: 'unexplained',
			detail:
				'The window changed after the input, but not in a way that shows this input did it, so sending it again could do it twice. Look at the window before repeating it.',
		}
	return {
		delivery: 'delivered_unverified',
		retrySafety: 'safe',
		outcome: 'no_effect',
		detail: 'The window did not change after the input: nothing in it took the input.',
	}
}

/** Keys whose effect (where the focus or caret is, how far a view scrolled) the controls of a window do not show. */
const UNOBSERVABLE_KEYS = /^(tab|up|down|left|right|home|end|pageup|pagedown|shift|ctrl|alt|win)$/i

/** The input kinds whose absence of effect a read of the window can show. */
export function canBeJudgedByStillness(action: {
	readonly type: string
	readonly keys?: string
}): boolean {
	if (action.type === 'type_text') return true
	if (action.type !== 'key' || action.keys === undefined) return false
	const main = action.keys.trim().split('+').pop()?.trim() ?? ''
	if (UNOBSERVABLE_KEYS.test(main)) return false
	// Enter, Backspace and Delete, and the undo, redo, cut and paste chords, change text a tree read may not show.
	const chord =
		action.keys.toLowerCase().includes('ctrl') || action.keys.toLowerCase().includes('cmd')
	if (/^(enter|return|backspace|delete|del|space)$/i.test(main)) return false
	if (chord && /^(z|y|x|v)$/i.test(main)) return false
	return true
}

/** One attempt as the retry decision sees it. */
export interface AttemptSummary {
	readonly delivery: ActionDelivery
	readonly retrySafety: ActionRetrySafety
	readonly detail?: string
	readonly outcome?: 'no_effect' | 'unexplained'
	/** The attempt used the screen (the foreground ladder). */
	readonly onScreen: boolean
	/** The ladder did not run it: the code says why (nothing was sent). */
	readonly blocked?: string
}

/** Whether a first attempt that left no effect is tried again on the screen. */
export function shouldRetryOnScreen(
	first: AttemptSummary,
	options: {
		readonly hasScreen: boolean
		readonly explicitMode: 'background' | 'foreground' | undefined
	},
): boolean {
	return (
		options.hasScreen &&
		options.explicitMode === undefined &&
		!first.onScreen &&
		first.outcome === 'no_effect' &&
		first.retrySafety === 'safe'
	)
}

const WAITING = new Set(['user_active', 'lease_busy'])

/**
 * The detail of the final result once a background attempt had no effect and
 * the retry on the screen was made (or could not be).
 */
export function escalationDetail(second: AttemptSummary): string {
	const base = 'The first attempt, in the background, had no effect: the window did not change.'
	if (second.blocked !== undefined) {
		if (WAITING.has(second.blocked))
			return `Waiting for you to be idle: ${base} Sending it again needs the screen, and it is in use, so nothing more was sent. It is safe to send it again once the keyboard and mouse are still. ${second.detail ?? ''}`.trim()
		return `${base} Sending it again on the screen was not possible, so nothing more was sent. ${second.detail ?? ''}`.trim()
	}
	if (second.outcome === 'no_effect')
		return `${base} It was sent again on the screen and the window still did not change, so nothing in the window takes this input (for text, no field has the focus: click the field first).`
	if (second.outcome === 'unexplained')
		return `${base} It was sent again on the screen and the window then changed in a way that cannot be tied to the input, so it is not safe to send it again. Look at the window first.`
	return `${base} It was sent again on the screen. ${second.detail ?? ''}`.trim()
}
