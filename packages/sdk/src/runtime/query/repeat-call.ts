import type { Message } from '../../types/message/index.js'
import { stableStringify } from './tool-grants.js'

/**
 * Notices a model issuing the same tool call over and over, and says so.
 *
 * Nothing in the kernel observed cross-call repetition. The guardrails
 * screen calls in isolation — input at run start, output at run end, one
 * result at a time — so a model re-running a failing command or
 * re-applying a diff that does not apply got no correction from anything.
 * The only lever was an iteration checkpoint, which fires on a COUNT
 * regardless of whether anything is repeating and needs a human at the
 * other end.
 *
 * It advises; it never denies. A repeat is not necessarily wrong — polling
 * for a build to finish is the same call by design — and a tracker that
 * refused would break that case to fix a different one. What the model
 * lacks is not permission but the observation, which it cannot make about
 * itself: each turn it sees a history, not a count.
 */

/** Same key `ToolGrantSet` uses, so "the same call" means one thing here. */
function keyFor(name: string, input: unknown): string {
	return `${name}:${stableStringify(input)}`
}

export interface RepeatCallThresholds {
	/** Repeats at which a first, mild notice is attached. */
	readonly notifyAfter: number
	/** Repeats at which the wording escalates. */
	readonly escalateAfter: number
}

export const DEFAULT_REPEAT_THRESHOLDS: RepeatCallThresholds = {
	notifyAfter: 3,
	escalateAfter: 5,
}

export interface RepeatCallNotice {
	readonly toolName: string
	readonly count: number
	readonly level: 'notice' | 'escalated'
	readonly text: string
}

/**
 * Run-scoped, like `ToolGrantSet` and for the same reason: a count carried
 * into a later run is a statement about work nobody repeated.
 */
export class RepeatCallTracker {
	private readonly counts = new Map<string, number>()
	/** Which keys have already been reported at which level, so one repeat
	 *  does not produce the same sentence on every subsequent turn. */
	private readonly announced = new Map<string, 'notice' | 'escalated'>()

	constructor(private readonly thresholds: RepeatCallThresholds = DEFAULT_REPEAT_THRESHOLDS) {}

	/**
	 * Records one call and returns a notice when this is the repeat that
	 * crosses a threshold, `undefined` otherwise.
	 */
	record(toolName: string, input: unknown): RepeatCallNotice | undefined {
		const key = keyFor(toolName, input)
		const count = (this.counts.get(key) ?? 0) + 1
		this.counts.set(key, count)

		const already = this.announced.get(key)
		if (count >= this.thresholds.escalateAfter && already !== 'escalated') {
			this.announced.set(key, 'escalated')
			return {
				toolName,
				count,
				level: 'escalated',
				text: `You have now called \`${toolName}\` with identical arguments ${count} times in this run. Repeating it again will produce the same result. Change the arguments, use a different tool, or tell the user what is blocking you and stop.`,
			}
		}
		if (count >= this.thresholds.notifyAfter && already === undefined) {
			this.announced.set(key, 'notice')
			return {
				toolName,
				count,
				level: 'notice',
				text: `Note: this is call ${count} of \`${toolName}\` with identical arguments in this run. If the previous results were not what you needed, changing the arguments is more likely to help than repeating them.`,
			}
		}
		return undefined
	}

	/** Repeats seen for one call, for a host that wants to render it. */
	countOf(toolName: string, input: unknown): number {
		return this.counts.get(keyFor(toolName, input)) ?? 0
	}
}

/**
 * Rides the notice out on the last `tool_result` of the batch.
 *
 * The same and only legal slot steering uses: a `tool_use` block must be
 * answered by a `tool_result` with the same id, so a user message wedged
 * between them is rejected by the provider outright.
 */
export function attachRepeatNotice(
	messages: readonly Message[],
	notices: readonly RepeatCallNotice[],
): readonly Message[] {
	if (notices.length === 0) return messages

	let lastToolIndex = -1
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === 'tool') {
			lastToolIndex = index
			break
		}
	}
	if (lastToolIndex === -1) return messages

	const target = messages[lastToolIndex] as Message
	// Text only, for the reason `attachSteering` gives: a result answered
	// with structured content has a shape the model reads positionally, and
	// appending a string to it is either dropped or corrupts the block. The
	// notice is advisory, so dropping it costs nothing a refusal would.
	if (typeof target.content !== 'string') return messages

	const next = [...messages]
	next[lastToolIndex] = {
		...target,
		content: `${target.content}\n\n${notices.map((n) => n.text).join('\n')}`,
	}
	return next
}
