/**
 * Two ways automatic compaction gives up for the rest of a turn.
 *
 * - Three failures in a row (a pass that ran and shed nothing): every one of
 *   them paid for a summary or a reducer call and left the history as it was,
 *   so a fourth would do the same. Proactive compaction is skipped from then on
 *   and the turn carries on, silently as far as the person is concerned (a log
 *   line and a `breaker_open` event, no sentence); a pass the provider forces
 *   by rejecting the prompt is not gated, so the reactive ladder still runs.
 * - Three compactions in a row, each followed by the history regaining all
 *   space shed within three iterations: something in the loop (a huge file
 *   read, a tool that prints without limit) refills the window faster than a
 *   summary can empty it. The turn stops, because carrying on buys the same wall.
 *
 * Off unless `compactionConfig.circuitBreaker` is true: stopping compaction,
 * and above all stopping a turn, is not something a host had before.
 *
 * State is per turn, held against the turn's recorder, so two turns never
 * share a count.
 */

import type { IterationContext } from './context.js'

/** Consecutive failed passes after which automatic compaction stops. */
export const COMPACTION_FAILURE_LIMIT = 3
/** A full refill sooner than this many iterations counts toward the limit. */
export const COMPACTION_REFILL_ITERATIONS = 3
/** Consecutive refills that stop the turn. */
export const COMPACTION_REFILL_LIMIT = 3

/**
 * One short line, shown once, when the turn stops on refills. It names the
 * cause and a step that keeps the conversation: starting over is never
 * offered here.
 */
export const COMPACTION_REFILL_MESSAGE =
	'The context filled up again right after being compacted, three times in a row. A file being read or a tool output is probably too large for the context window. Try reading it in smaller parts.'

export class CompactionBreaker {
	private failures = 0
	private refills = 0
	private pendingRefills = 0
	private lastCompactedIteration: number | undefined
	private lastTokensBefore = 0
	private lastTokensAfter = 0
	private failureNoticeSent = false
	private stopReason: string | undefined

	/** Whether three failures in a row have switched automatic compaction off. */
	get failuresOpen(): boolean {
		return this.failures >= COMPACTION_FAILURE_LIMIT
	}

	/** Mark the failure notice sent; true the first time only. */
	takeFailureNotice(): boolean {
		if (this.failureNoticeSent) return false
		this.failureNoticeSent = true
		return true
	}

	recordFailure(): void {
		this.failures++
	}

	/** A pass committed an edit; failures start over. */
	recordRelief(): void {
		this.failures = 0
	}

	/**
	 * A summary or reducer pass is about to run at `iteration`. True when it
	 * would be the third refill in a row, in which case it must not run.
	 */
	wouldTrip(iteration: number, tokens: number): boolean {
		// Iteration distance alone confuses continued pressure with a refill:
		// a small reduction may leave the prompt above its trigger. Compare the
		// same history estimator on both sides, never provider usage against an
		// estimate. Count only when new context has replaced ALL the space shed.
		const refilled = this.lastTokensAfter < this.lastTokensBefore && tokens >= this.lastTokensBefore
		const quick =
			this.lastCompactedIteration !== undefined &&
			iteration - this.lastCompactedIteration < COMPACTION_REFILL_ITERATIONS
		this.pendingRefills = quick && refilled ? this.refills + 1 : 0
		return this.pendingRefills >= COMPACTION_REFILL_LIMIT
	}

	/** The allowed pass completed; both sizes must use the same history estimator. */
	recordCompaction(iteration: number, tokensBefore: number, tokensAfter: number): void {
		this.refills = this.pendingRefills
		this.lastCompactedIteration = iteration
		this.lastTokensBefore = tokensBefore
		this.lastTokensAfter = tokensAfter
		this.recordRelief()
	}

	stopTurn(message: string): void {
		this.stopReason ??= message
	}

	/** The reason the turn must stop, when a breaker has asked for it. */
	get stop(): string | undefined {
		return this.stopReason
	}
}

const breakers = new WeakMap<object, CompactionBreaker>()

/** The turn's breaker, or `undefined` when the host did not opt in. */
export function compactionBreaker(ctx: IterationContext): CompactionBreaker | undefined {
	if (ctx.compactionConfig?.circuitBreaker !== true) return undefined
	let breaker = breakers.get(ctx.recorder)
	if (!breaker) {
		breaker = new CompactionBreaker()
		breakers.set(ctx.recorder, breaker)
	}
	return breaker
}
