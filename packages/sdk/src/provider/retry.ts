import { classifyProviderError, isAbortError } from '../types/provider/errors.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../types/provider/index.js'
import type { Logger } from '../utils/logger.js'
import { isProviderRequestError } from './errors.js'

export interface ProviderRetryConfig {
	/** Retry attempts AFTER the initial try. `0` disables retrying. */
	readonly maxRetries: number
	/** First backoff, doubled each attempt. */
	readonly initialDelayMs: number
	/** Ceiling for a single backoff, before jitter. */
	readonly maxDelayMs: number
	/**
	 * Cap on a server-directed `Retry-After`. A provider asking for 15
	 * minutes should not silently park an interactive run for 15 minutes;
	 * past this we surface the error and let the caller decide.
	 */
	readonly maxRetryAfterMs: number
}

export const DEFAULT_PROVIDER_RETRY: ProviderRetryConfig = {
	maxRetries: 3,
	initialDelayMs: 500,
	maxDelayMs: 16_000,
	maxRetryAfterMs: 60_000,
}

/**
 * Full jitter (AWS's formulation): sleep a uniform random amount in
 * `[0, backoff]` rather than `backoff` exactly. Equal-jitter and no-jitter
 * both keep a fleet of clients that failed together retrying together;
 * full jitter is what actually spreads a thundering herd.
 */
function backoffWithJitter(attempt: number, config: ProviderRetryConfig, random: () => number) {
	const exponential = Math.min(config.initialDelayMs * 2 ** attempt, config.maxDelayMs)
	return Math.round(random() * exponential)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
	const config: ProviderRetryConfig = { ...DEFAULT_PROVIDER_RETRY, ...options.config }
	const random = options.random ?? Math.random
	const doSleep = options.sleepFn ?? sleep
	const log = options.log

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
				// A driver that already classified its own failure has said
				// everything this layer would: re-wrapping it would replace a
				// first-hand statement with a guess, and the run boundary reads
				// that classification to choose between a pause and a failure.
				if (isProviderRequestError(err)) throw err

				const classified = classifyProviderError(err, provider.id)
				const exhausted = attempt >= config.maxRetries

				if (produced || !classified.retryable || exhausted) {
					log?.warn('Provider call failed', {
						provider: provider.id,
						code: classified.code,
						status: classified.status,
						attempt: attempt + 1,
						retryable: classified.retryable,
						reason: produced
							? 'stream already produced output — cannot retry without duplicating it'
							: exhausted
								? 'retries exhausted'
								: 'not retryable',
					})
					throw classified
				}

				const serverDirected = classified.retryAfterMs
				const delay =
					serverDirected !== undefined && serverDirected <= config.maxRetryAfterMs
						? serverDirected
						: backoffWithJitter(attempt, config, random)

				log?.warn('Provider call failed — retrying', {
					provider: provider.id,
					code: classified.code,
					status: classified.status,
					attempt: attempt + 1,
					maxRetries: config.maxRetries,
					delayMs: delay,
					serverDirected: serverDirected !== undefined,
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
		...(provider.healthCheck ? { healthCheck: () => provider.healthCheck?.() } : {}),
		...(provider.doctorCheck ? { doctorCheck: () => provider.doctorCheck?.() } : {}),
	} as LLMProvider
}
