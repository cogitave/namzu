import { createRuntimeContextMessage } from '../../types/message/index.js'
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
 * It advises, and it refuses exactly one thing. A repeat is not
 * necessarily wrong — polling for a build to finish is the same call by
 * design — so a repeat that keeps SUCCEEDING is only ever noticed. A repeat
 * that keeps FAILING the same way is different: an operator watched a
 * model ask a desktop it could not reach for a screenshot, read the same
 * error, and ask again, for as long as the turn was allowed to go on. After
 * `refuseFailedAfter` consecutive identical failures the next identical
 * call is answered with a refusal instead of being run, and the refusal
 * says why. A success resets the count, so a poll that fails a few times
 * before it succeeds is never touched. What the model lacks is not
 * permission but the observation, which it cannot make about itself: each
 * turn it sees a history, not a count.
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
	/**
	 * Consecutive identical FAILURES after which the next identical call is
	 * refused rather than run. A success in between resets the count.
	 */
	readonly refuseFailedAfter: number
}

export const DEFAULT_REPEAT_THRESHOLDS: RepeatCallThresholds = {
	notifyAfter: 3,
	escalateAfter: 5,
	refuseFailedAfter: 4,
}

export interface RepeatCallNotice {
	readonly toolName: string
	readonly count: number
	readonly level: 'notice' | 'escalated'
	readonly text: string
}

/**
 * Turn-scoped, like `ToolGrantSet` and for the same reason: a count carried
 * into a later turn is a statement about work nobody repeated.
 */
export class RepeatCallTracker {
	private readonly counts = new Map<string, number>()
	/** Which keys have already been reported at which level, so one repeat
	 *  does not produce the same sentence on every subsequent turn. */
	private readonly announced = new Map<string, 'notice' | 'escalated'>()
	/** Consecutive failures per key; a success deletes the entry. */
	private readonly failures = new Map<string, number>()

	constructor(private readonly thresholds: RepeatCallThresholds = DEFAULT_REPEAT_THRESHOLDS) {}

	/**
	 * Records one call and returns a notice when this is the repeat that
	 * crosses a threshold, `undefined` otherwise. `outcome.failed` is what
	 * the refusal counts; a call recorded without an outcome counts as a
	 * repeat but never towards a refusal.
	 */
	record(
		toolName: string,
		input: unknown,
		outcome?: { readonly failed: boolean },
	): RepeatCallNotice | undefined {
		const key = keyFor(toolName, input)
		const count = (this.counts.get(key) ?? 0) + 1
		this.counts.set(key, count)
		if (outcome?.failed === true) this.failures.set(key, (this.failures.get(key) ?? 0) + 1)
		else if (outcome?.failed === false) this.failures.delete(key)

		const already = this.announced.get(key)
		if (count >= this.thresholds.escalateAfter && already !== 'escalated') {
			this.announced.set(key, 'escalated')
			return {
				toolName,
				count,
				level: 'escalated',
				text: `You have now called \`${toolName}\` with identical arguments ${count} times in this turn. Repeating it again will produce the same result. Change the arguments, use a different tool, or tell the user what is blocking you and stop.`,
			}
		}
		if (count >= this.thresholds.notifyAfter && already === undefined) {
			this.announced.set(key, 'notice')
			return {
				toolName,
				count,
				level: 'notice',
				text: `Note: this is call ${count} of \`${toolName}\` with identical arguments in this turn. If the previous results were not what you needed, changing the arguments is more likely to help than repeating them.`,
			}
		}
		return undefined
	}

	/** Repeats seen for one call, for a host that wants to render it. */
	countOf(toolName: string, input: unknown): number {
		return this.counts.get(keyFor(toolName, input)) ?? 0
	}

	/**
	 * The refusal for a call that has failed identically too many times in
	 * a row, or `undefined` when the call may run. Asked BEFORE execution;
	 * the refused call is still recorded afterwards, as a failure, so the
	 * refusal holds until the model changes something.
	 */
	refusal(toolName: string, input: unknown): string | undefined {
		const failed = this.failures.get(keyFor(toolName, input)) ?? 0
		if (failed < this.thresholds.refuseFailedAfter) return undefined
		return `Refused: \`${toolName}\` with these exact arguments has failed ${failed} times in a row in this turn, with the same result each time. It will not be run again with these arguments. Change the arguments, use a different tool, or tell the user what is blocking you and stop.`
	}
}

/**
 * Rides the notice out on the last `tool_result` of the batch, same slot
 * steering uses: a `tool_use` block must be answered by a `tool_result` with
 * the same id, so a user message wedged between them is rejected by the
 * provider outright.
 *
 * That slot only exists when the trailing result's content is plain text. A
 * result answered with structured content (an image, a document, an MCP
 * block) has a shape the model reads positionally, and appending a string to
 * it is either dropped or corrupts the block — this used to mean the notice
 * was simply dropped, on the theory that an advisory costs nothing to lose.
 * It costs more than a refusal would: `RepeatCallTracker.record` already
 * marked the threshold as announced the moment it fired, so a notice lost
 * here never comes back, unlike steering, which can requeue and wait for a
 * later plain-text result. The fallback instead rides out as its own
 * `runtime-context` message placed AFTER the complete tool-result batch —
 * never between a `tool_use` and its `tool_result`, so provider-required
 * adjacency still holds — carrying that provenance so it is never mistaken
 * for operator input (see `isOperatorUserMessage` in `steering.ts`).
 */
export function attachRepeatNotice(
	messages: readonly Message[],
	notices: readonly RepeatCallNotice[],
): readonly Message[] {
	if (notices.length === 0) return messages

	const noticeText = notices.map((n) => n.text).join('\n')

	let lastToolIndex = -1
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === 'tool') {
			lastToolIndex = index
			break
		}
	}
	const target = lastToolIndex === -1 ? undefined : (messages[lastToolIndex] as Message)

	if (target && typeof target.content === 'string') {
		const next = [...messages]
		next[lastToolIndex] = { ...target, content: `${target.content}\n\n${noticeText}` }
		return next
	}

	return [...messages, createRuntimeContextMessage(noticeText, 'repeat-call')]
}
