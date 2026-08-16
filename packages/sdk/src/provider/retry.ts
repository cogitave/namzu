import { GENAI } from '../constants/telemetry/index.js'
import { classifyProviderError, isAbortError } from '../types/provider/errors.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../types/provider/index.js'
import { type BackoffPolicy, backoffWithJitter, sleep } from '../utils/backoff.js'
import type { Logger } from '../utils/logger.js'
import { isProviderRequestError } from './errors.js'

/**
 * `BackoffPolicy` plus the provider-specific parts: how many attempts, and
 * how long a server-directed wait may be honoured for.
 *
 * The curve itself lives in `utils/backoff.ts` and is shared with the tool
 * executor's in-loop retry — which had no backoff at all while this one was
 * being careful about jitter two directories away.
 */
export interface ProviderRetryConfig extends BackoffPolicy {
	/** Retry attempts AFTER the initial try. `0` disables retrying. */
	readonly maxRetries: number
	/**
	 * Cap on a server-directed `Retry-After`. A provider asking for 15
	 * minutes should not silently park an interactive run for 15 minutes;
	 * past this we surface the error and let the caller decide.
	 *
	 * "Surface" is the whole of it: there is no shorter retry underneath. A
	 * server that named a wait has said something specific, and answering it
	 * with a half-second backoff neither honours the wait nor tells anyone it
	 * was refused. The error carries `retryAfterMs`, so a host that wants to
	 * come back in fifteen minutes can — that decision is above this loop.
	 *
	 * Raise it to let the run sleep longer; a request under the ceiling is
	 * still slept exactly as instructed.
	 */
	readonly maxRetryAfterMs: number
}

export const DEFAULT_PROVIDER_RETRY: ProviderRetryConfig = {
	maxRetries: 3,
	initialDelayMs: 500,
	maxDelayMs: 16_000,
	maxRetryAfterMs: 60_000,
}

export interface WithProviderRetryOptions {
	readonly config?: Partial<ProviderRetryConfig>
	readonly log?: Logger
	/** Seam for deterministic tests. */
	readonly random?: () => number
	readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Wrap a provider so transient failures are retried with exponential
 * backoff and full jitter.
 *
 * **Retry only before the first content chunk.** Once a delta has been
 * yielded the consumer has already emitted `text_delta` events and
 * appended to its buffer, so restarting the request would duplicate
 * output. A mid-stream failure is therefore surfaced, not retried — the
 * existing stream-error path in `streamProviderTurn` handles it (and can
 * still salvage a truncated tool call). This is the whole reason the
 * retry lives in a decorator rather than inside the loop: the loop cannot
 * un-emit.
 *
 * Aborts propagate untouched so a Stop still settles the run as
 * `cancelled` rather than being mistaken for a transport failure.
 */
export function withProviderRetry(
	provider: LLMProvider,
	options: WithProviderRetryOptions = {},
): LLMProvider {
	// Three layers, and the order is the contract. A driver's declaration is
	// a DEFAULT — it sits above the generic one and below whatever the
	// caller asked for, because the caller asked for something specific and
	// the driver is only expressing what usually suits its vendor.
	//
	// Merged HERE rather than at the one call site in `query()`, because
	// this function is exported: a host wrapping its own chain must get the
	// same precedence, and a merge upstream would give it the generic
	// default while `query()` got the driver's.
	const config: ProviderRetryConfig = {
		...DEFAULT_PROVIDER_RETRY,
		...provider.retryDefaults,
		...options.config,
	}
	const random = options.random ?? Math.random
	const doSleep = options.sleepFn ?? sleep
	const log = options.log

	// AFTER the merge. Above it, a driver declaring `maxRetries: 0` — the
	// one that most needs to be honoured, because it is saying its vendor
	// must not be retried — was read from the generic default instead and
	// retried anyway.
	if (config.maxRetries <= 0) return provider

	async function* chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		for (let attempt = 0; ; attempt++) {
			let produced = false
			try {
				for await (const chunk of provider.chatStream(params)) {
					// An error-only chunk is a failure report, not output: it
					// leaves `produced` false so a driver that surfaces errors
					// in-band is still retryable on its first chunk.
					const isErrorOnly =
						chunk.error !== undefined && !chunk.delta.content && !chunk.delta.toolCalls?.length

					if (!isErrorOnly) produced = true

					if (isErrorOnly && !produced && attempt < config.maxRetries) {
						throw new Error(chunk.error)
					}
					yield chunk
				}
				return
			} catch (err) {
				if (isAbortError(err) || params.signal?.aborted) throw err
				// A driver that already classified its own failure keeps that
				// classification — `classifyProviderError` reads its `kind`
				// first and does not re-guess.
				//
				// This used to rethrow such an error outright. The stated reason
				// was sound and the code did more than it said: preserving a
				// first-hand classification is one thing, and skipping the retry
				// loop is another. A first-party driver that correctly reported
				// a 429 as `kind: 'throttle'` got ZERO attempts, while the same
				// failure from a driver that classified nothing got the full
				// backoff — so diagnosing your own error was punished. Whether
				// to retry is now decided the same way for both, by the
				// classification's own `retryable`.
				const classified = classifyProviderError(err, provider.id)
				const exhausted = attempt >= config.maxRetries

				if (produced || !classified.retryable || exhausted) {
					log?.warn('Provider call failed', {
						[GENAI.SYSTEM]: provider.id,
						'namzu.provider.code': classified.code,
						'namzu.provider.status': classified.status,
						'namzu.retry.attempt': attempt + 1,
						'namzu.provider.retryable': classified.retryable,
						'namzu.provider.reason': produced
							? 'stream already produced output — cannot retry without duplicating it'
							: exhausted
								? 'retries exhausted'
								: 'not retryable',
					})
					// The ORIGINAL escapes when the driver classified it. Two
					// different consumers want two different things and both are
					// right: this loop needs a retryable verdict, which the
					// classification supplies, and the run boundary reports
					// `lastProviderError` as the driver's own `{kind, status,
					// retryAfterMs}`, which only survives if the error itself
					// does. Wrapping here would have kept the retry fix and lost
					// the vendor's `kind` at the boundary — the existing
					// stream-recovery test caught exactly that.
					throw isProviderRequestError(err) ? err : classified
				}

				const serverDirected = classified.retryAfterMs

				// The server named a wait longer than the caller's ceiling, so the
				// error goes to the caller — which is what `maxRetryAfterMs`
				// documents and what it now does.
				//
				// It used to fall through to the jittered backoff instead, and that
				// is degrading where the contract says refuse
				// (`docs/conventions/refuse-do-not-degrade.md`). The ceiling was
				// read as "how long may I sleep", so a provider asking for fifteen
				// minutes was re-asked in half a second: the one instruction the
				// server gave was the one thing discarded, and the retries that
				// followed were sent to an endpoint that had already said it would
				// not serve them. They cost the run its whole budget to rediscover
				// a 429 it had been told about in advance.
				//
				// The caller loses nothing it had. This throws the SAME error the
				// exhausted path throws, so the run settles exactly as it did
				// before — only sooner, and with `retryAfterMs` intact for a host
				// that wants to schedule against it. What it gains is the wait
				// itself, which no backoff of ours can honour: fifteen minutes is
				// not a number this loop is allowed to sleep for.
				//
				// With a chain declared it gains more than that. The error is a
				// `rate_limit`, which is a fact about the MEMBER, so
				// `withProviderFallback` moves to the next one — the run continues
				// on another provider instead of spending its budget arguing with
				// the first. Under the old behaviour the chain did not see the
				// failure until those attempts were gone.
				if (serverDirected !== undefined && serverDirected > config.maxRetryAfterMs) {
					log?.warn('Provider call failed — server-directed wait exceeds the ceiling', {
						[GENAI.SYSTEM]: provider.id,
						'namzu.provider.code': classified.code,
						'namzu.provider.status': classified.status,
						'namzu.retry.attempt': attempt + 1,
						'namzu.provider.retry_after_ms': serverDirected,
						'namzu.provider.max_retry_after_ms': config.maxRetryAfterMs,
						'namzu.provider.reason':
							'surfacing rather than retrying — the caller decides how to wait',
					})
					throw isProviderRequestError(err) ? err : classified
				}

				const delay = serverDirected ?? backoffWithJitter(attempt, config, random)

				log?.warn('Provider call failed — retrying', {
					[GENAI.SYSTEM]: provider.id,
					'namzu.provider.code': classified.code,
					'namzu.provider.status': classified.status,
					'namzu.retry.attempt': attempt + 1,
					'namzu.provider.max_retries': config.maxRetries,
					'namzu.provider.delay_ms': delay,
					'namzu.provider.server_directed': serverDirected !== undefined,
				})

				// Tell the consumer BEFORE sleeping. With the default policy a
				// run can sit silent for the better part of a minute between
				// `iteration_started` and the next event, and a server-directed
				// delay may take it to the full cap — a host with no signal
				// cannot tell a backoff from a hang, and its watchdog cancels a
				// run that was about to succeed. This is the only channel open
				// while the decorator sleeps: the consumer is blocked inside
				// this iterator, so a callback could not reach it until the
				// backoff was already over.
				yield {
					id: '',
					delta: {},
					retry: {
						attempt: attempt + 1,
						maxRetries: config.maxRetries,
						delayMs: delay,
						code: classified.code,
						...(classified.status !== undefined ? { status: classified.status } : {}),
						serverDirected: serverDirected !== undefined,
					},
				}

				await doSleep(delay, params.signal)
			}
		}
	}

	// Preserve identity and every optional capability of the wrapped driver;
	// the decorator must be transparent to capability negotiation.
	return {
		get id() {
			return provider.id
		},
		get name() {
			return provider.name
		},
		get capabilities() {
			return provider.capabilities
		},
		chatStream,
		...(provider.listModels ? { listModels: () => provider.listModels?.() } : {}),
		// The model is forwarded, not dropped. A wrapper that swallowed it would
		// leave the wrapped driver probing whatever it probes with no argument
		// — which for at least one driver is "nothing", so the check would come
		// back unanswerable purely because it was wrapped.
		...(provider.healthCheck
			? { healthCheck: (model?: string) => provider.healthCheck?.(model) }
			: {}),
		...(provider.doctorCheck
			? { doctorCheck: (model?: string) => provider.doctorCheck?.(model) }
			: {}),
		// Forwarded for the same reason `healthCheck` is, and both were
		// missing until something consumed them. A member this wrapper drops
		// does not fail — it reads as "this driver cannot answer", which is a
		// legitimate state and therefore a silent one. Retry is on by
		// default, so a dropped member is dropped on essentially every run.
		//
		// `effortLevelsFor` was in that position and had no consumer at all,
		// which is exactly why nobody noticed: a driver's declared effort
		// levels became invisible the moment its provider was wrapped.
		...(provider.effortLevelsFor
			? {
					effortLevelsFor: (
						model: string,
						thinking?: Parameters<NonNullable<LLMProvider['effortLevelsFor']>>[1],
					) => provider.effortLevelsFor?.(model, thinking) ?? [],
				}
			: {}),
		...(provider.resolveContextWindow
			? {
					resolveContextWindow: (model: string, signal?: AbortSignal) =>
						provider.resolveContextWindow?.(model, signal) ?? Promise.resolve(undefined),
				}
			: {}),
	} as LLMProvider
}
