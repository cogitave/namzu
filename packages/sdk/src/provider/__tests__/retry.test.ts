import { describe, expect, it, vi } from 'vitest'

import { ProviderError, classifyProviderError, isAbortError } from '../../types/provider/errors.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import { withProviderRetry } from '../retry.js'

const PARAMS = { model: 'm', messages: [] } as unknown as ChatCompletionParams

function chunk(content: string): StreamChunk {
	return { id: 'c', delta: { content } }
}

/** A driver whose behavior is scripted per attempt. */
function scripted(
	script: Array<() => AsyncIterable<StreamChunk>>,
): LLMProvider & { calls: number } {
	let calls = 0
	const provider = {
		id: 'scripted',
		name: 'Scripted',
		chatStream: (_params: ChatCompletionParams) => {
			const step = script[Math.min(calls, script.length - 1)]
			calls++
			if (!step) throw new Error('script exhausted')
			return step()
		},
		get calls() {
			return calls
		},
	}
	return provider as unknown as LLMProvider & { calls: number }
}

function httpError(status: number, message = `HTTP ${status}`, headers?: Record<string, string>) {
	return Object.assign(new Error(message), { status, headers })
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<string> {
	let out = ''
	for await (const c of stream) out += c.delta.content ?? ''
	return out
}

const noSleep = async () => {}

describe('classifyProviderError', () => {
	it.each([
		[429, 'rate_limit', true],
		[529, 'overloaded', true],
		[503, 'overloaded', true],
		[500, 'server_error', true],
		[502, 'server_error', true],
		[408, 'timeout', true],
		[401, 'auth', false],
		[403, 'auth', false],
		[404, 'not_found', false],
		[400, 'invalid_request', false],
	])('maps HTTP %i to %s (retryable=%s)', (status, code, retryable) => {
		const e = classifyProviderError(httpError(status as number))
		expect(e.code).toBe(code)
		expect(e.retryable).toBe(retryable)
		expect(e.status).toBe(status)
	})

	it('files a window overflow as context_length_exceeded even though it arrives as a 400', () => {
		const e = classifyProviderError(httpError(400, 'prompt is too long: 250000 tokens > 200000'))
		expect(e.code).toBe('context_length_exceeded')
		// Retrying the identical request cannot help — the caller must shed history.
		expect(e.retryable).toBe(false)
	})

	it('classifies transport errnos without a status', () => {
		expect(
			classifyProviderError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).code,
		).toBe('network')
		expect(
			classifyProviderError(Object.assign(new Error('slow'), { code: 'ETIMEDOUT' })).code,
		).toBe('timeout')
		// undici nests the errno under `cause`.
		expect(
			classifyProviderError(Object.assign(new Error('x'), { cause: { code: 'EAI_AGAIN' } })).code,
		).toBe('network')
	})

	it('reads Retry-After as delta-seconds and as an HTTP date', () => {
		expect(classifyProviderError(httpError(429, '', { 'retry-after': '2' })).retryAfterMs).toBe(
			2000,
		)

		const now = Date.parse('2026-07-31T10:00:00Z')
		const at = new Date(now + 5000).toUTCString()
		expect(
			classifyProviderError(httpError(429, '', { 'retry-after': at }), undefined, now).retryAfterMs,
		).toBe(5000)
	})

	it('is idempotent — re-classifying a ProviderError returns it unchanged', () => {
		const first = classifyProviderError(httpError(429))
		expect(classifyProviderError(first)).toBe(first)
	})

	it('does not treat an abort as a provider failure', () => {
		const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
		expect(isAbortError(abort)).toBe(true)
	})
})

describe('withProviderRetry', () => {
	it('retries a 429 and succeeds', async () => {
		const provider = scripted([
			() => {
				throw httpError(429)
			},
			async function* () {
				yield chunk('ok')
			},
		])
		const wrapped = withProviderRetry(provider, { sleepFn: noSleep, random: () => 0.5 })
		expect(await drain(wrapped.chatStream(PARAMS))).toBe('ok')
		expect(provider.calls).toBe(2)
	})

	it('does NOT retry a 400 — a malformed request stays malformed', async () => {
		const provider = scripted([
			() => {
				throw httpError(400, 'bad tool schema')
			},
		])
		const wrapped = withProviderRetry(provider, { sleepFn: noSleep })
		await expect(drain(wrapped.chatStream(PARAMS))).rejects.toMatchObject({
			code: 'invalid_request',
		})
		expect(provider.calls).toBe(1)
	})

	it('gives up after maxRetries and throws a classified ProviderError', async () => {
		const provider = scripted([
			() => {
				throw httpError(503)
			},
		])
		const wrapped = withProviderRetry(provider, {
			config: { maxRetries: 2 },
			sleepFn: noSleep,
		})
		const err = await drain(wrapped.chatStream(PARAMS)).catch((e) => e)
		expect(err).toBeInstanceOf(ProviderError)
		expect(err.code).toBe('overloaded')
		expect(provider.calls).toBe(3) // initial + 2 retries
	})

	it('NEVER retries once a content chunk has been produced', async () => {
		// Retrying here would replay "hello" and duplicate it in the buffer
		// the consumer has already emitted as text_delta events.
		const provider = scripted([
			async function* () {
				yield chunk('hello')
				throw httpError(503)
			},
			async function* () {
				yield chunk('SHOULD NOT HAPPEN')
			},
		])
		const wrapped = withProviderRetry(provider, { sleepFn: noSleep })

		let seen = ''
		const err = await (async () => {
			try {
				for await (const c of wrapped.chatStream(PARAMS)) seen += c.delta.content ?? ''
				return undefined
			} catch (e) {
				return e
			}
		})()

		expect(seen).toBe('hello')
		expect(err).toBeInstanceOf(ProviderError)
		expect(provider.calls).toBe(1)
	})

	it('retries a driver that reports failure in-band via chunk.error', async () => {
		const provider = scripted([
			async function* () {
				yield { id: 'c', delta: {}, error: 'overloaded_error' } as StreamChunk
			},
			async function* () {
				yield chunk('recovered')
			},
		])
		const wrapped = withProviderRetry(provider, { sleepFn: noSleep })
		expect(await drain(wrapped.chatStream(PARAMS))).toBe('recovered')
		expect(provider.calls).toBe(2)
	})

	it('honours a server-directed Retry-After instead of the computed backoff', async () => {
		const slept: number[] = []
		const provider = scripted([
			() => {
				throw httpError(429, 'slow down', { 'retry-after': '7' })
			},
			async function* () {
				yield chunk('ok')
			},
		])
		const wrapped = withProviderRetry(provider, {
			sleepFn: async (ms) => {
				slept.push(ms)
			},
		})
		await drain(wrapped.chatStream(PARAMS))
		expect(slept).toEqual([7000])
	})

	/**
	 * The ceiling refuses; it does not shorten.
	 *
	 * This case used to assert the opposite — a 15-minute `Retry-After` fell
	 * through to a 500ms backoff — which is what `maxRetryAfterMs` did and the
	 * reverse of what it documented. The doc was ruled correct: a server that
	 * named a wait has told the caller something they asked to be told about,
	 * and answering it in half a second honours neither the wait nor the
	 * refusal.
	 *
	 * Both halves are asserted. Retrying-shorter and surfacing differ only in
	 * what happens NEXT, so a test that watched the sleep alone would pass
	 * against a decorator that slept nothing and then retried anyway.
	 */
	it('surfaces a Retry-After past the ceiling instead of retrying sooner', async () => {
		const slept: number[] = []
		const provider = scripted([
			() => {
				throw httpError(429, '', { 'retry-after': '900' }) // 15 minutes
			},
			async function* () {
				yield chunk('never reached')
			},
		])
		const wrapped = withProviderRetry(provider, {
			config: { maxRetryAfterMs: 60_000, initialDelayMs: 500 },
			random: () => 1,
			sleepFn: async (ms) => {
				slept.push(ms)
			},
		})

		// The error reaches the caller carrying the wait it was told about, so a
		// host can schedule against the number rather than re-parse it.
		await expect(drain(wrapped.chatStream(PARAMS))).rejects.toMatchObject({
			status: 429,
			retryAfterMs: 900_000,
		})
		expect(slept).toEqual([])
		expect(provider.calls).toBe(1)
	})

	it('still sleeps a server-directed wait that fits under the ceiling', async () => {
		const slept: number[] = []
		const provider = scripted([
			() => {
				throw httpError(429, '', { 'retry-after': '30' })
			},
			async function* () {
				yield chunk('ok')
			},
		])
		const wrapped = withProviderRetry(provider, {
			config: { maxRetryAfterMs: 60_000, initialDelayMs: 500 },
			random: () => 1,
			sleepFn: async (ms) => {
				slept.push(ms)
			},
		})

		expect(await drain(wrapped.chatStream(PARAMS))).toBe('ok')
		expect(slept).toEqual([30_000])
	})

	it('applies full jitter — the delay is scaled by the random source', async () => {
		const slept: number[] = []
		const provider = scripted([
			() => {
				throw httpError(500)
			},
			() => {
				throw httpError(500)
			},
			async function* () {
				yield chunk('ok')
			},
		])
		const wrapped = withProviderRetry(provider, {
			config: { initialDelayMs: 1000, maxDelayMs: 16_000 },
			random: () => 0.5,
			sleepFn: async (ms) => {
				slept.push(ms)
			},
		})
		await drain(wrapped.chatStream(PARAMS))
		// attempt 0 → 0.5 * 1000, attempt 1 → 0.5 * 2000
		expect(slept).toEqual([500, 1000])
	})

	it('propagates an abort untouched so the run still settles as cancelled', async () => {
		const controller = new AbortController()
		controller.abort()
		const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
		const provider = scripted([
			() => {
				throw abortErr
			},
		])
		const wrapped = withProviderRetry(provider, { sleepFn: noSleep })
		await expect(drain(wrapped.chatStream({ ...PARAMS, signal: controller.signal }))).rejects.toBe(
			abortErr,
		)
		expect(provider.calls).toBe(1)
	})

	it('returns the provider untouched when retrying is disabled', () => {
		const provider = scripted([])
		expect(withProviderRetry(provider, { config: { maxRetries: 0 } })).toBe(provider)
	})

	it('is transparent to identity and capability negotiation', () => {
		const base = {
			id: 'anthropic',
			name: 'Anthropic',
			capabilities: { supportsTools: true, supportsVision: false },
			chatStream: async function* () {},
			listModels: vi.fn(async () => []),
		} as unknown as LLMProvider
		const wrapped = withProviderRetry(base)
		expect(wrapped.id).toBe('anthropic')
		expect(wrapped.name).toBe('Anthropic')
		expect(wrapped.capabilities).toEqual({ supportsTools: true, supportsVision: false })
		expect(typeof wrapped.listModels).toBe('function')
		expect(wrapped.healthCheck).toBeUndefined()
	})
})
