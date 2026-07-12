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
 * Run `onElapsed` after `delayMs`, slicing a delay above {@link MAX_TIMER_DELAY_MS}
 * into re-armed chunks so Node's 32-bit clamp cannot turn a long wait into a 1 ms
 * one. Returns a canceller for the pending timer.
 *
 * The countdown is arithmetic, not wall-clock. The run deadline is an absolute
 * instant, so `armDeadline` re-reads the clock on every re-arm and a suspended
 * process cannot overshoot it silently. A backoff is a *duration*: subtracting each
 * slice keeps the overwhelmingly common single-slice case (a delay under the
 * ceiling) at exactly one `setTimeout` for exactly the requested delay, with no
 * clock read to drift against.
 */
function armSlicedTimer(delayMs: number, onElapsed: () => void): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined

	const arm = (left: number): void => {
		const slice = Math.min(left, MAX_TIMER_DELAY_MS)
		timer = setTimeout(() => {
			const rest = left - slice
			if (rest <= 0) {
				onElapsed()
				return
			}
			arm(rest)
		}, slice)
	}
	arm(delayMs)

	return (): void => {
		if (timer !== undefined) clearTimeout(timer)
	}
}

/**
 * Sleep for `ms`, resolving early (returning `true`) if `signal` aborts first.
 * Returns `false` if the full delay elapsed. Removes its abort listener so a
 * long-lived signal does not accumulate listeners across attempts.
 *
 * The wait is armed through {@link armSlicedTimer}, not a bare `setTimeout`. The
 * backoff delay is bounded by `retry.maxDelayMs`, and the retry schema accepts any
 * non-negative number there — `Infinity` included — while a server-advised
 * `retryAfterMs` is only clamped to that same ceiling. A delay above 2^31-1 ms
 * handed straight to `setTimeout` is silently clamped to **1 ms**, so the very
 * configuration that asks the loop to back off hardest is the one that would make
 * it hammer a throttled provider with no wait at all (ses_015 pre-freeze R4 M1 —
 * the same clamp the deadline timer was fixed for in R2).
 */
function sleepOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(true)
	if (ms <= 0) return Promise.resolve(false)
	return new Promise<boolean>((resolve) => {
		let cancelTimer = (): void => {}
		const onAbort = (): void => {
			cancelTimer()
			resolve(true)
		}
		signal.addEventListener('abort', onAbort, { once: true })
		cancelTimer = armSlicedTimer(ms, () => {
			signal.removeEventListener('abort', onAbort)
			resolve(false)
		})
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
 * Returned in place of a response when the pre-invocation gate decides the request
 * must not be issued at all. It is not an error and never surfaces: the gate has
 * already settled the outer promise, so this only tells the response handler that
 * there is no response to resolve with. A sentinel rather than `undefined` because
 * `undefined` is a value a misbehaving adapter could actually return.
 */
const NOT_ISSUED = Symbol('model-call:not-issued')

/**
 * Issue one physical `provider.chat` and settle on whichever comes first: the
 * provider's own answer, the run signal aborting, or the run deadline elapsing.
 *
 * **Abort and deadline are first-come, and abort has PRIORITY over a concurrent
 * response.** Both settle this promise in the tick they are observed, and the
 * request is not issued once either has landed — not before the pre-check, not
 * during `onAttempt`, not between installing the listener and invoking the
 * provider, not in the microtask gap in between, and not, once a response does
 * arrive, without re-reading the clock that the response may have outrun. A
 * provider response wins only when it wins outright.
 *
 * A response that resolves in the SAME TICK as an abort is discarded, and its usage
 * goes unaccounted. That is deliberate, and it is a stated semantic rather than an
 * artifact: cancellation is a stop signal, not a vote. The alternative — letting a
 * response that landed microseconds before the abort be accepted — means a
 * CANCELLED run accepts a model response and acts on it (hooks, tools, history),
 * which is a strictly more dangerous direction than under-accounting the cost of a
 * run that was cancelled anyway. The deadline path behaves the same way, so the two
 * stop conditions are consistent (ses_015 pre-freeze R6, adjudicated).
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
	// The signal is read BEFORE the clock. Both stop conditions can be true at once —
	// `onAttempt` runs a host observer between the caller's checks and this call, and
	// an abort raised there can coincide with the deadline coming due — and whichever
	// is inspected first is the one the call is reported as. Reading the clock first
	// reported a cancelled run as a `network` failure: the catch below sees
	// `signal.aborted` and rethrows verbatim, so the misclassification travelled all
	// the way out to the caller, where a user cancel looked like a transport fault
	// (ses_015 pre-freeze R6 m1). An abort is what actually happened; it wins the tie.
	if (signal.aborted) {
		return Promise.reject(
			new ProviderRequestError('Aborted before the request was issued', {
				kind: 'aborted',
				providerId: provider.id,
			}),
		)
	}

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
	let onAbort: (() => void) | undefined

	const cleanup = (): void => {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
		if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
	}

	return new Promise<ChatCompletionResponse>((resolve, reject) => {
		let settled = false

		const settle = (action: () => void): void => {
			if (settled) return
			settled = true
			action()
		}

		const abortWait = (message: string): void => {
			settle(() => {
				reject(new ProviderRequestError(message, { kind: 'aborted', providerId: provider.id }))
			})
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

		// SYNCHRONOUS, in the abort event's own tick. The earlier version deferred this
		// rejection through a zero-delay timer, to let a chat promise that had already
		// resolved settle first. But `provider.chat` is invoked from a MICROTASK, and
		// microtasks run ahead of timers: the deferral did not hand the race to a
		// finished call, it handed the race to EVERY call — an abort could be observed,
		// scheduled, and then beaten by a provider that had not even been asked yet.
		// Cancellation is a stop signal, not a vote, so it settles the moment it lands
		// and everything downstream of it becomes a no-op through `settle` (ses_015
		// pre-freeze R5 B1).
		onAbort = (): void => {
			abortWait('Aborted during model call')
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

		// `addEventListener` does NOT replay an abort that already fired. The caller
		// checks `signal.aborted` before the attempt, but host code runs between that
		// check and this listener — `onAttempt` is a user-supplied observer — and an
		// abort raised THERE was observed by nobody: the listener never fired, and the
		// wait ran on until the deadline against a provider that may not honor the
		// signal. Re-checking here closes the window on every ordering: whatever else
		// happens, an abort that is already visible settles the call now (ses_015
		// pre-freeze R4 B1).
		if (signal.aborted) abortWait('Aborted before the request was issued')

		// The race is already decided — by the abort above, or by `armDeadline` finding
		// the clock past `deadlineAt` on its own re-read. Issuing the request anyway
		// buys a result nobody can use (the promise has settled) at the price of a
		// round trip and, on a provider that cannot be aborted, the tokens (ses_015
		// pre-freeze R4 m1).
		if (settled) return

		// `Promise.resolve().then(...)` rather than a bare call: a conforming adapter
		// may validate its params and throw SYNCHRONOUSLY out of `chat()`, and that
		// throw has to arrive as a rejection of THIS promise so it settles through the
		// same path — and reaches the same cleanup — as every other failure.
		Promise.resolve()
			.then<ChatCompletionResponse | typeof NOT_ISSUED>(() => {
				// Last gate before the request leaves the process. The checks above ran in
				// the executor's tick; this callback runs a microtask later, and both stop
				// conditions can land in that gap — an abort delivered right after
				// `callWithinDeadline` returns, or a deadline that simply comes due (its
				// timer cannot fire before this microtask, so the timer alone would let the
				// request go out and only abandon the wait afterwards). Re-reading both here
				// is what makes "not issued" true rather than merely "not awaited": on a
				// provider that ignores the signal, an issued request is billed however
				// promptly we walk away from it (ses_015 pre-freeze R5 B1 + M1).
				if (signal.aborted) {
					abortWait('Aborted before the request was issued')
					return NOT_ISSUED
				}
				if (Date.now() >= deadlineAt) {
					abandonWait()
					return NOT_ISSUED
				}
				return provider.chat({ ...params, signal })
			})
			.then(
				(response) => {
					if (response === NOT_ISSUED) return

					// The deadline is enforced when the value ARRIVES, not only before it is
					// asked for. The timer cannot be trusted to have fired: a provider that
					// blocks SYNCHRONOUSLY past `deadlineAt` — a slow local model, a busy
					// tokenizer, a long JSON parse — holds the event loop, so the overdue
					// timer is a macrotask that cannot run, while the provider's own promise
					// reaction is a microtask that runs first. The response then arrived after
					// the budget was spent and was accepted anyway: accounted into the run's
					// usage, handed to hooks, appended to the history. Re-reading the clock
					// here is the only check that observes the overrun, and it produces the
					// same retryable rejection the timer would have (ses_015 pre-freeze R6 B1).
					if (signal.aborted) {
						abortWait('Aborted during model call')
						return
					}
					if (Date.now() >= deadlineAt) {
						abandonWait()
						return
					}
					settle(() => resolve(response))
				},
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
