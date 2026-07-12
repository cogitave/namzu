import { DEFAULT_RETRY_CONFIG } from '../../config/runtime.js'
import { ProviderRequestError, isProviderRequestError } from '../../provider/errors.js'
import type { ChatCompletionParams, ChatCompletionResponse } from '../../types/provider/chat.js'
import type { LLMProvider } from '../../types/provider/interface.js'
import type { AgentRunConfig, RetryConfig } from '../../types/run/index.js'
import { toErrorMessage } from '../../utils/error.js'
import type { Logger } from '../../utils/logger.js'

/**
 * Resolve the effective {@link RetryConfig} for a run. Whole-object fallback:
 * an absent `runConfig.retry` yields {@link DEFAULT_RETRY_CONFIG}; a provided
 * config is used verbatim (it is already fully-specified per the interface).
 */
export function resolveRetryConfig(runConfig: AgentRunConfig): RetryConfig {
	return runConfig.retry ?? DEFAULT_RETRY_CONFIG
}

/**
 * Self-contained wall budget for an sdk-internal chat outside the main loop
 * (compaction verifier, router, advisory). Since ses_015 pre-freeze B2 this is a
 * hard bound on the call itself, not merely a retry window, so it is sized for a
 * slow local model summarising a large excerpt rather than for a fast API turn.
 */
const ANCILLARY_CALL_BUDGET_MS = 120_000

/**
 * Largest delay `setTimeout` can express (2^31 - 1 ms, ~24.8 days). Node stores
 * the delay in a signed 32-bit integer: a larger value overflows and is silently
 * clamped to **1 ms**, with a `TimeoutOverflowWarning`.
 *
 * That clamp turned a generous run budget into an instant failure. A run
 * configured with, say, a 30-day `timeoutMs` armed its deadline timer for
 * 2_592_000_000 ms, Node fired it 1 ms later, and every model call — healthy
 * provider, prompt answer — was abandoned as a retryable `network` error before
 * it could return. All retries burned on the same clamp, and the iteration's
 * timeout branch did not even classify the stop as a timeout, because the real
 * deadline was still a month away: the run simply failed (ses_015 pre-freeze R2).
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Kinds that a plain retry can plausibly recover from. */
export function isRetryableKind(kind: string): boolean {
	return kind === 'throttle' || kind === 'server' || kind === 'network'
}

/**
 * Sleep for `ms`, resolving early (returning `true`) if `signal` aborts first.
 * Returns `false` if the full delay elapsed. Removes its abort listener so a
 * long-lived signal does not accumulate listeners across attempts.
 */
function sleepOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(true)
	if (ms <= 0) return Promise.resolve(false)
	return new Promise<boolean>((resolve) => {
		const onAbort = (): void => {
			clearTimeout(timer)
			resolve(true)
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve(false)
		}, ms)
		signal.addEventListener('abort', onAbort, { once: true })
	})
}

/**
 * Compute the backoff wait before the next attempt. Honors a server-advised
 * `retryAfterMs` when present; otherwise full-jitter exponential backoff
 * (`random(0, min(base * 2^(attempt-1), maxDelayMs))`).
 *
 * A server-advised `retryAfterMs` is clamped to `retry.maxDelayMs` too: a hostile
 * or misparsed `Retry-After` (e.g. an hours-long value) must not stall the loop
 * for the entire remaining run budget — the configured ceiling exists precisely
 * for this case (ses_015 fix-batch). The run deadline still bounds the wait on
 * top of this clamp in the caller.
 */
function computeBackoffDelay(err: unknown, attempt: number, retry: RetryConfig): number {
	if (
		isProviderRequestError(err) &&
		typeof err.retryAfterMs === 'number' &&
		err.retryAfterMs >= 0
	) {
		return Math.min(err.retryAfterMs, retry.maxDelayMs)
	}
	const exp = retry.baseDelayMs * 2 ** (attempt - 1)
	const capped = Math.min(exp, retry.maxDelayMs)
	return Math.random() * capped
}

/**
 * Issue one physical `provider.chat` and settle on whichever comes first: the
 * provider's own answer, the run signal aborting, or the run deadline elapsing.
 *
 * **The in-flight request is not cancelled by this function — the *wait* for it
 * is.** `signal` is still forwarded to the provider, so an adapter that honors it
 * (`ProviderCapabilities.supportsAbortSignal`) does tear the socket down. But an
 * adapter that cannot (Ollama's non-streaming `chat()` takes no signal at all)
 * will keep the HTTP request open until its own transport gives up, and the
 * process will keep paying for the tokens it eventually returns. What this bound
 * guarantees is the only guarantee available for such a provider: a hung or
 * late-returning call can no longer hold the loop past `deadlineAt`, and its late
 * response can no longer flow into hooks, tools, or the message history. The
 * deadline rejection is thrown as a retryable transport kind so the iteration
 * catch's timeout branch (`Date.now() >= guard.deadlineAt` + retryable kind)
 * fires and the run stops as `timeout` rather than as a failure.
 *
 * The clock is re-read here, immediately before the request is issued. The caller
 * checks the deadline too, but time passes between the two — `onAttempt` runs a
 * host observer in between — and a request issued into an already-spent budget is
 * a request nobody can use: it would be raced against a zero-delay timer and
 * abandoned, having cost a round trip and, on a provider that cannot be aborted,
 * the tokens too.
 *
 * Every timer and listener installed here is torn down in a `finally`, on every
 * path out — including the one where a provider validates its params and throws
 * SYNCHRONOUSLY from `chat()`. That throw is routed through the same settle path
 * as any other rejection. When cleanup hung off `settle` alone it never ran on
 * that path, and every such attempt leaked a live deadline timer and an abort
 * listener that could hold the process open for the rest of the run budget.
 */
function callWithinDeadline(
	provider: LLMProvider,
	params: ChatCompletionParams,
	signal: AbortSignal,
	deadlineAt: number,
): Promise<ChatCompletionResponse> {
	const remaining = deadlineAt - Date.now()
	if (remaining <= 0) {
		return Promise.reject(
			new ProviderRequestError('Run deadline elapsed before the request was issued', {
				kind: 'network',
				providerId: provider.id,
			}),
		)
	}

	let deadlineTimer: ReturnType<typeof setTimeout> | undefined
	let abortTimer: ReturnType<typeof setTimeout> | undefined
	let onAbort: (() => void) | undefined

	const cleanup = (): void => {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
		if (abortTimer !== undefined) clearTimeout(abortTimer)
		if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
	}

	return new Promise<ChatCompletionResponse>((resolve, reject) => {
		let settled = false

		const settle = (action: () => void): void => {
			if (settled) return
			settled = true
			action()
		}

		onAbort = (): void => {
			// An abort does not throw away work already done. The loop deliberately
			// accounts usage and fires `post_llm_call` for a call that COMPLETED even
			// though the run was cancelled in the meantime (ses_015 A4) — the tokens
			// were spent either way, and observers should see the call that happened.
			// So the abort rejection is deferred by one turn of the event loop, which
			// lets a chat promise that has ALREADY resolved settle first. When the
			// provider genuinely has nothing to give yet, this fires and the wait is
			// abandoned — which is what keeps `cancel()` from hanging until the
			// deadline on an adapter that cannot be aborted.
			abortTimer = setTimeout(() => {
				settle(() => {
					reject(
						new ProviderRequestError('Aborted during model call', {
							kind: 'aborted',
							providerId: provider.id,
						}),
					)
				})
			}, 0)
		}

		const abandonWait = (): void => {
			settle(() => {
				reject(
					new ProviderRequestError(
						'Model call exceeded the run deadline while in flight — abandoning the wait',
						{ kind: 'network', providerId: provider.id },
					),
				)
			})
		}

		// A deadline further out than {@link MAX_TIMER_DELAY_MS} cannot be expressed in
		// one `setTimeout` — Node would clamp it to 1 ms and abandon the call at once —
		// so a long budget is counted down in slices and only fires when the clock has
		// actually reached `deadlineAt`. Re-reading the clock on each re-arm also means
		// a suspended process cannot overshoot silently.
		const armDeadline = (): void => {
			const left = deadlineAt - Date.now()
			if (left <= 0) {
				abandonWait()
				return
			}
			deadlineTimer = setTimeout(
				left > MAX_TIMER_DELAY_MS ? armDeadline : abandonWait,
				Math.min(left, MAX_TIMER_DELAY_MS),
			)
		}
		armDeadline()

		signal.addEventListener('abort', onAbort, { once: true })

		// `Promise.resolve().then(...)` rather than a bare call: a conforming adapter
		// may validate its params and throw SYNCHRONOUSLY out of `chat()`, and that
		// throw has to arrive as a rejection of THIS promise so it settles through the
		// same path — and reaches the same cleanup — as every other failure.
		Promise.resolve()
			.then(() => provider.chat({ ...params, signal }))
			.then(
				(response) => settle(() => resolve(response)),
				(err) => settle(() => reject(err)),
			)
	}).finally(cleanup)
}

export interface AttemptModelCallArgs {
	provider: LLMProvider
	/** Chat params WITHOUT `signal` — the loop injects `signal` on every attempt. */
	params: ChatCompletionParams
	retry: RetryConfig
	signal: AbortSignal
	/** Absolute epoch-ms deadline (from `GuardCoordinator.deadlineAt`). */
	deadlineAt: number
	log: Logger
	/** Best-effort per-attempt observer; thrown errors are logged and swallowed. */
	onAttempt?: (info: { attempt: number; maxAttempts: number }) => void
}

/**
 * Execute a single logical model call with bounded retries.
 *
 * Retries only `throttle`/`server`/`network` {@link ProviderRequestError}s;
 * everything else (including `aborted`, `context_overflow`, `auth`,
 * `bad_request`, `unknown`, and non-`ProviderRequestError` throws) is rethrown
 * to the caller immediately. `aborted` and a tripped `signal` short-circuit
 * with no further attempts.
 *
 * Time budget: `deadlineAt` bounds the whole logical call, not just the number
 * of attempts. Each attempt runs through {@link callWithinDeadline}, which
 * abandons the wait when the deadline elapses even if the provider has not
 * answered — without that, a single hanging request could hold the loop open
 * indefinitely and a bounded attempt count would bound nothing (ses_015
 * pre-freeze B2). Backoff waits are capped both by `retry.maxDelayMs` (via
 * {@link computeBackoffDelay}) and by the time remaining until `deadlineAt`, and
 * every sleep races `signal`. When the deadline is reached the last observed
 * error is rethrown so the caller can consult the same clock and classify the
 * stop as a timeout (ses_015 A3, M8).
 */
export async function attemptModelCall(
	args: AttemptModelCallArgs,
): Promise<ChatCompletionResponse> {
	const { provider, params, retry, signal, deadlineAt, log, onAttempt } = args
	const maxAttempts = retry.enabled ? Math.max(1, retry.maxAttempts) : 1
	let lastError: unknown

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (signal.aborted) {
			throw new ProviderRequestError('Aborted before model call attempt', {
				kind: 'aborted',
				providerId: provider.id,
			})
		}

		if (Date.now() >= deadlineAt) {
			if (lastError !== undefined) throw lastError
			throw new ProviderRequestError('Run deadline exceeded before model call attempt', {
				kind: 'network',
				providerId: provider.id,
			})
		}

		if (onAttempt) {
			try {
				onAttempt({ attempt, maxAttempts })
			} catch (observerErr) {
				log.warn('onAttempt observer threw — ignoring', {
					error: toErrorMessage(observerErr),
				})
			}
		}

		try {
			return await callWithinDeadline(provider, params, signal, deadlineAt)
		} catch (err) {
			lastError = err

			if (signal.aborted || (isProviderRequestError(err) && err.kind === 'aborted')) {
				throw err
			}

			const kind = isProviderRequestError(err) ? err.kind : 'unknown'
			if (!isRetryableKind(kind) || attempt >= maxAttempts) {
				throw err
			}

			const remaining = deadlineAt - Date.now()
			if (remaining <= 0) throw err

			const delay = Math.min(computeBackoffDelay(err, attempt, retry), remaining)
			log.debug('Model call failed — retrying after backoff', {
				attempt,
				maxAttempts,
				kind,
				delayMs: Math.round(delay),
			})

			const abortedDuringSleep = await sleepOrAbort(delay, signal)
			if (abortedDuringSleep) {
				throw new ProviderRequestError('Aborted during retry backoff', {
					kind: 'aborted',
					providerId: provider.id,
					cause: err,
				})
			}
		}
	}

	// Unreachable in practice — the loop either returns or throws — but keeps
	// the function total for the type checker.
	throw (
		lastError ??
		new ProviderRequestError('Model call failed with no attempts', {
			kind: 'unknown',
			providerId: provider.id,
		})
	)
}

/**
 * Thin, ergonomic wrapper over {@link attemptModelCall} for SDK-internal chat
 * callers OUTSIDE the main iteration loop (compaction verifier, RouterAgent
 * routing, advisory consult). Those sites call `provider.chat` directly; because
 * every provider adapter now disables its own vendor-SDK retry loop
 * (`maxRetries: 0`), an unwrapped call has zero retries and a single transient
 * `throttle`/`server`/`network` blip fails the whole operation. This restores
 * bounded retry coverage without threading the loop's full plumbing.
 *
 * Defaults for the ancillary controls: `retry` → {@link DEFAULT_RETRY_CONFIG};
 * `deadlineAt` → `now + ANCILLARY_CALL_BUDGET_MS` (a self-contained budget, never
 * the exhausted run deadline); `signal` → a never-aborting signal when the caller
 * has none in scope. `log` is required. Stays sdk-internal — not re-exported from
 * the package root, so the dependency direction is unchanged.
 */
export function chatWithRetry(
	provider: LLMProvider,
	params: ChatCompletionParams,
	opts: { retry?: RetryConfig; signal?: AbortSignal; log: Logger; deadlineAt?: number },
): Promise<ChatCompletionResponse> {
	return attemptModelCall({
		provider,
		params,
		retry: opts.retry ?? DEFAULT_RETRY_CONFIG,
		signal: opts.signal ?? new AbortController().signal,
		deadlineAt: opts.deadlineAt ?? Date.now() + ANCILLARY_CALL_BUDGET_MS,
		log: opts.log,
	})
}
