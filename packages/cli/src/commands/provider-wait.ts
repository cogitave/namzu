/**
 * How long a headless run waits when the provider says "not now".
 *
 * A pause is a rate limit or an outage: the kernel kept a checkpoint and the
 * right response is to wait and resume, not to fail and not to re-prompt from
 * whatever notes the run left behind. This module decides HOW LONG, and it is
 * pure so the decision can be tested without a clock.
 *
 * The provider's own delay wins when it gave one. Without one, the wait backs
 * off — a minute, two, four — because a limit that did not name its window is
 * not helped by polling it, and is capped so a run never sleeps longer than it
 * would take a person to notice it is asleep.
 */

export const FIRST_WAIT_MS = 60_000
export const MAX_WAIT_MS = 15 * 60_000
export const MIN_WAIT_MS = 1_000

export interface PauseWaitInput {
	/** How many pauses this run has already waited through. 0 for the first. */
	readonly waited: number
	/** Delay the provider asked for, when it gave one. */
	readonly retryAfterMs?: number
	/** Wall-clock milliseconds this run has spent waiting so far. */
	readonly waitedMs: number
	/** The most this run may spend waiting in total. */
	readonly budgetMs: number
}

export type PauseWaitDecision =
	| { readonly kind: 'wait'; readonly delayMs: number }
	| { readonly kind: 'stop'; readonly reason: string }

/** The delay before the next resume, or why there will not be one. */
export function pauseWait(input: PauseWaitInput): PauseWaitDecision {
	if (input.budgetMs <= 0) return { kind: 'stop', reason: 'no wait budget' }
	const backoff = Math.min(FIRST_WAIT_MS * 2 ** input.waited, MAX_WAIT_MS)
	const asked = input.retryAfterMs
	const delayMs =
		typeof asked === 'number' && Number.isFinite(asked) && asked >= 0
			? Math.max(MIN_WAIT_MS, asked)
			: backoff
	if (input.waitedMs + delayMs > input.budgetMs) {
		return {
			kind: 'stop',
			reason: `the next wait (${duration(delayMs)}) would exceed the ${duration(input.budgetMs)} wait budget after ${duration(input.waitedMs)} already spent`,
		}
	}
	return { kind: 'wait', delayMs }
}

/**
 * `90s`, `30m`, `2h`, `500ms`, or a bare number of seconds, to milliseconds.
 * Refused, naming the flag, for anything else — a duration a wrapper mistyped
 * is not one to guess at.
 */
export function durationMs(value: string, flag: string): number {
	const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(value.trim())
	if (!match) {
		throw new Error(`${flag} takes a duration such as 90s, 30m or 2h, got ${JSON.stringify(value)}`)
	}
	const amount = Number(match[1])
	const unit = match[2] ?? 's'
	const factor = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000
	const ms = Math.round(amount * factor)
	if (ms <= 0) throw new Error(`${flag} must be above zero, got ${JSON.stringify(value)}`)
	return ms
}

/** A duration for a status line: `45 seconds`, `2 minutes`, `1 hour`. */
export function duration(ms: number): string {
	if (ms < 1_000) return `${Math.ceil(ms)} ms`
	const seconds = Math.round(ms / 1_000)
	if (seconds < 120) return `${seconds} second${seconds === 1 ? '' : 's'}`
	const minutes = Math.round(seconds / 60)
	if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`
	const hours = Math.round(minutes / 60)
	return `${hours} hour${hours === 1 ? '' : 's'}`
}
