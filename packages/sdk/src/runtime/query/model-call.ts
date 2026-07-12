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

/** Kinds that a plain retry can plausibly recover from. */
function isRetryableKind(kind: string): boolean {
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
 * Time budget: before each attempt the loop checks the run deadline; a wait is
 * capped both by `retry.maxDelayMs` (via {@link computeBackoffDelay}) and by
 * the time remaining until `deadlineAt`, and the sleep races `signal`. When the
 * deadline is reached the last observed error is rethrown so the caller can
 * consult the same clock and classify the stop as a timeout (ses_015 A3, M8).
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
			return await provider.chat({ ...params, signal })
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
 * `deadlineAt` → `now + 60_000` (a self-contained budget, never the exhausted
 * run deadline); `signal` → a never-aborting signal when the caller has none in
 * scope. `log` is required. Stays sdk-internal — not re-exported from the
 * package root, so the dependency direction is unchanged.
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
		deadlineAt: opts.deadlineAt ?? Date.now() + 60_000,
		log: opts.log,
	})
}
