import type { ChatCompletionParams, StreamChunk } from '../types/provider/index.js'
import type { LLMProvider } from '../types/provider/interface.js'
import type { Logger } from '../utils/logger.js'
import { ProviderRequestError } from './errors.js'

/**
 * Notices a stream that stopped producing without ending.
 *
 * One driver had a per-chunk watchdog, written inline, and it defaulted to
 * OFF — so zero of seven drivers re-armed on a stall unless a host set a
 * config key it had no reason to know about. The only other bound is each
 * driver's whole-REQUEST timeout, which a stream that opened successfully
 * and then went quiet does not trip: the request is fine, the bytes have
 * simply stopped.
 *
 * A run in that state is not slow, it is stuck. It holds its budget, its
 * claim and its process, and nothing settles it until an operator
 * notices — which is the failure mode a kernel with checkpoints and
 * budgets exists to make impossible.
 *
 * ## Why a decorator and not a driver feature
 *
 * Written once here, in the shape `withProviderRetry` and
 * `withProviderFallback` already use, so it composes with them rather than
 * being reimplemented per driver. The failure is classified `network`,
 * which is the same classification the inline version produced and the one
 * retry and fallback already know how to act on: a stalled stream is
 * retried by the layer above, or the chain moves to the next member.
 *
 * ## What it cannot do
 *
 * It cannot un-emit. A stall AFTER the first chunk surfaces as an error
 * rather than a silent restart, exactly as `withProviderRetry` documents
 * for the same reason — the consumer has already emitted those deltas.
 */

export interface WithStreamIdleTimeoutOptions {
	/**
	 * Milliseconds without a chunk before the stream is treated as stalled.
	 * `0` or a non-finite value disables the watchdog and returns the
	 * provider unwrapped.
	 */
	readonly idleTimeoutMs: number
	readonly log?: Logger
	/** Test seam. Defaults to `setTimeout`. */
	readonly setTimeoutFn?: typeof setTimeout
	/** Test seam. Defaults to `clearTimeout`. */
	readonly clearTimeoutFn?: typeof clearTimeout
}

export function withStreamIdleTimeout(
	provider: LLMProvider,
	options: WithStreamIdleTimeoutOptions,
): LLMProvider {
	const { idleTimeoutMs } = options
	// Unwrapped rather than wrapped-and-inert. A disabled watchdog that
	// still races a promise per chunk costs the hottest path in the runtime
	// a timer and a closure for nothing.
	if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return provider

	const arm = options.setTimeoutFn ?? setTimeout
	const disarm = options.clearTimeoutFn ?? clearTimeout

	async function* chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const iterator = provider.chatStream(params)[Symbol.asyncIterator]()
		try {
			for (;;) {
				let timer: ReturnType<typeof setTimeout> | undefined
				let result: IteratorResult<StreamChunk>
				try {
					result = await Promise.race([
						iterator.next(),
						new Promise<never>((_resolve, reject) => {
							timer = arm(() => {
								reject(
									new ProviderRequestError({
										kind: 'network',
										providerId: provider.id,
										detail: `stream idle for ${Math.round(idleTimeoutMs / 1000)}s — aborting so the run lifecycle can settle it`,
									}),
								)
							}, idleTimeoutMs)
						}),
					])
				} finally {
					// In a `finally`, so a rejection from either side of the
					// race clears the timer. Clearing only on success leaks one
					// per stalled stream, and a leaked timer keeps the process
					// alive past the run it belonged to.
					if (timer !== undefined) disarm(timer)
				}
				if (result.done) return
				yield result.value
			}
		} finally {
			// Asked to clean up, NOT awaited — and the difference is the whole
			// case this decorator exists for. A generator stalled inside an
			// `await` is not suspended at a `yield`, so `return()` resumes
			// nothing and its promise never settles: awaiting it deadlocks on
			// precisely the stalled stream the watchdog just caught. (Found
			// that way: the first version hung this file's own test.)
			//
			// The call still matters — a driver holding a socket has no other
			// signal that nobody is reading — so it is made and abandoned,
			// with the rejection swallowed because there is no one left to
			// tell.
			void iterator.return?.().catch(() => {})
		}
	}

	return { ...provider, chatStream }
}
