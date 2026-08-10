/**
 * Exponential backoff with full jitter, and an abortable sleep.
 *
 * Both were private to `provider/retry.ts`, which is where they were needed
 * first and is not where they stop being needed. The tool executor's in-loop
 * retry re-ran a failed call immediately, several times, which is the pattern
 * most likely to prolong the very condition it is retrying against — and the
 * correct implementation was one directory away, already reviewed, already
 * doing the hard part right.
 *
 * So they live here, in one copy, and both retry loops call them. A second
 * implementation of a backoff curve is a second thing to get wrong, and the
 * two would drift on exactly the axis nobody re-derives: jitter.
 */

/** The shape a backoff curve needs. */
export interface BackoffPolicy {
	/** First backoff, doubled each attempt. */
	readonly initialDelayMs: number
	/** Ceiling for a single backoff, before jitter. */
	readonly maxDelayMs: number
}

/**
 * Full jitter (AWS's formulation): sleep a uniform random amount in
 * `[0, backoff]` rather than `backoff` exactly. Equal-jitter and no-jitter
 * both keep a fleet of clients that failed together retrying together;
 * full jitter is what actually spreads a thundering herd.
 *
 * `attempt` is 0-based: attempt 0 draws from `[0, initialDelayMs]`.
 *
 * The concurrency this matters for is not hypothetical on the tool path. A
 * model emits a batch of parallel calls, they hit one rate-limited endpoint
 * together, and they fail together — so a fixed delay would resynchronise
 * them on every attempt, which is a herd this loop creates itself.
 */
export function backoffWithJitter(
	attempt: number,
	policy: BackoffPolicy,
	random: () => number = Math.random,
): number {
	const exponential = Math.min(policy.initialDelayMs * 2 ** attempt, policy.maxDelayMs)
	return Math.round(random() * exponential)
}

/**
 * Sleep, unless the signal says not to.
 *
 * Rejects with the signal's reason when aborted — before sleeping if it is
 * already aborted, and mid-sleep otherwise. A caller that must not throw over
 * an abort catches it; a caller that wants the abort to propagate does not.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve()
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason)
			return
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		const onAbort = () => {
			clearTimeout(timer)
			reject(signal?.reason)
		}
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}
