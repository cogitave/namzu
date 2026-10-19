import { describe, expect, it, vi } from 'vitest'

import type { SessionEventDraft } from '../../runtime/query/events.js'
import { streamProviderTurn } from '../../runtime/query/iteration/stream-turn.js'
import type { TurnId } from '../../types/ids/index.js'
import { classifyProviderError } from '../../types/provider/errors.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import type { SessionEvent } from '../../types/session/index.js'
import type { Logger } from '../../utils/logger.js'
import { ProviderRequestError, providerHttpError } from '../errors.js'
import { type ProviderRetryConfig, withProviderRetry } from '../retry.js'

/**
 * The terminal's retry policy, expressed as `ProviderRetryConfig`: ten retries,
 * a doubling backoff from half a second to thirty-two that only adds jitter,
 * `Retry-After` as a floor under the backoff, and a stream that dies after
 * some text restarted rather than given up on. These are opt-in fields; the
 * defaults of the config are unchanged and are covered by `retry.test.ts`.
 */

const PARAMS = { model: 'm', messages: [] } as unknown as ChatCompletionParams

const REFERENCE: Partial<ProviderRetryConfig> = {
	maxRetries: 10,
	initialDelayMs: 500,
	maxDelayMs: 32_000,
	maxRetryAfterMs: 60_000,
	jitter: 'proportional',
	retryAfter: 'floor',
	retryMidStream: true,
}

function http(status: number, headers?: Record<string, string>) {
	return Object.assign(new Error(`HTTP ${status}`), { status, headers })
}

/** Fails `errors.length` times, one error per attempt, then answers. */
function flaky(errors: unknown[], answer: StreamChunk[]): LLMProvider & { calls: number } {
	let calls = 0
	return {
		id: 'flaky',
		name: 'Flaky',
		capabilities: {},
		get calls() {
			return calls
		},
		async *chatStream() {
			const err = errors[calls++]
			if (err !== undefined) throw err
			for (const c of answer) yield c
		},
	} as unknown as LLMProvider & { calls: number }
}

async function collect(provider: LLMProvider): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const c of provider.chatStream(PARAMS)) out.push(c)
	return out
}

const ok: StreamChunk[] = [{ id: 'c', delta: { content: 'ok' } }]

function recorder() {
	const delays: number[] = []
	return { delays, sleepFn: async (ms: number) => void delays.push(ms) }
}

describe('the backoff curve', () => {
	it('doubles from 500 ms and never goes below the step, adding at most a quarter', async () => {
		for (const [random, factor] of [
			[0, 1],
			[1, 1.25],
		] as const) {
			const { delays, sleepFn } = recorder()
			const provider = withProviderRetry(
				flaky(
					Array.from({ length: 8 }, () => http(503)),
					ok,
				),
				{ config: REFERENCE, sleepFn, random: () => random },
			)
			await collect(provider)
			const steps = [500, 1000, 2000, 4000, 8000, 16000, 32000, 32000]
			expect(delays).toEqual(steps.map((s) => Math.round(s * factor)))
		}
	})

	it('makes eleven attempts in all, then surfaces the error', async () => {
		const { sleepFn } = recorder()
		const inner = flaky(
			Array.from({ length: 20 }, () => http(503)),
			ok,
		)
		const provider = withProviderRetry(inner, {
			config: REFERENCE,
			sleepFn,
			random: () => 0,
		})
		await expect(collect(provider)).rejects.toMatchObject({
			code: 'overloaded',
		})
		expect(inner.calls).toBe(11)
	})

	it('keeps full jitter and exact Retry-After when the new fields are absent', async () => {
		const { delays, sleepFn } = recorder()
		const provider = withProviderRetry(flaky([http(429, { 'retry-after': '1' }), http(503)], ok), {
			sleepFn,
			random: () => 0.5,
		})
		await collect(provider)
		// 1 s exactly, then a full-jitter draw from [0, 1000].
		expect(delays).toEqual([1000, 500])
	})
})

describe('Retry-After as a floor', () => {
	it('sleeps the longer of the server wait and the backoff', async () => {
		const { delays, sleepFn } = recorder()
		const errors = [
			http(503),
			http(503),
			http(429, { 'retry-after': '1' }),
			http(429, { 'retry-after': '9' }),
		]
		await collect(
			withProviderRetry(flaky(errors, ok), {
				config: REFERENCE,
				sleepFn,
				random: () => 0,
			}),
		)
		// attempt 3 backs off 2000 > 1000; attempt 4 asks for 9000 > 4000.
		expect(delays).toEqual([500, 1000, 2000, 9000])
	})

	it('does not retry a wait past the ceiling', async () => {
		const { delays, sleepFn } = recorder()
		const inner = flaky([http(429, { 'retry-after': '61' })], ok)
		const provider = withProviderRetry(inner, { config: REFERENCE, sleepFn })
		await expect(collect(provider)).rejects.toMatchObject({
			code: 'rate_limit',
		})
		expect(inner.calls).toBe(1)
		expect(delays).toEqual([])
	})
})

describe('a stream that dies after some text', () => {
	function dropsAfter(text: string, then: StreamChunk[]): LLMProvider & { calls: number } {
		let calls = 0
		return {
			id: 'drops',
			name: 'Drops',
			capabilities: {},
			get calls() {
				return calls
			},
			async *chatStream() {
				if (calls++ === 0) {
					yield { id: 'a', delta: { content: text } }
					throw Object.assign(new Error('socket hang up'), {
						code: 'ECONNRESET',
					})
				}
				for (const c of then) yield c
			},
		} as unknown as LLMProvider & { calls: number }
	}

	it('is restarted, and the notice says the first attempt is void', async () => {
		const { delays, sleepFn } = recorder()
		const inner = dropsAfter('par', [{ id: 'b', delta: { content: 'whole answer' } }])
		const chunks = await collect(
			withProviderRetry(inner, { config: REFERENCE, sleepFn, random: () => 0 }),
		)
		expect(inner.calls).toBe(2)
		expect(delays).toEqual([500])
		expect(chunks.map((c) => c.retry?.restart ?? c.delta.content)).toEqual([
			'par',
			true,
			'whole answer',
		])
	})

	it('is surfaced, as before, unless the host opted in', async () => {
		const { sleepFn } = recorder()
		const inner = dropsAfter('par', ok)
		const provider = withProviderRetry(inner, {
			config: { ...REFERENCE, retryMidStream: false },
			sleepFn,
		})
		await expect(collect(provider)).rejects.toMatchObject({ code: 'network' })
		expect(inner.calls).toBe(1)
	})

	it('is never restarted once a tool call has begun', async () => {
		const { sleepFn } = recorder()
		let calls = 0
		const inner = {
			id: 'tool',
			name: 'Tool',
			capabilities: {},
			async *chatStream() {
				calls++
				yield {
					id: 'a',
					delta: {
						toolCalls: [{ index: 0, id: 't1', function: { name: 'x', arguments: '{' } }],
					},
				}
				throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
			},
		} as unknown as LLMProvider
		await expect(
			collect(withProviderRetry(inner, { config: REFERENCE, sleepFn })),
		).rejects.toMatchObject({ code: 'network' })
		expect(calls).toBe(1)
	})
})

describe('the provider saying not to retry', () => {
	it('x-should-retry: false on a raw vendor error stops a 5xx retry', async () => {
		const { sleepFn } = recorder()
		const inner = flaky([http(503, { 'x-should-retry': 'false' })], ok)
		await expect(
			collect(withProviderRetry(inner, { config: REFERENCE, sleepFn })),
		).rejects.toMatchObject({ retryable: false })
		expect(inner.calls).toBe(1)
	})

	it('is carried through a classified driver error', () => {
		const err = providerHttpError({
			providerId: 'p',
			status: 503,
			body: '',
			shouldRetry: 'false',
		})
		expect(err).toBeInstanceOf(ProviderRequestError)
		expect(err.shouldRetry).toBe(false)
		expect(classifyProviderError(err).retryable).toBe(false)
		const plain = providerHttpError({
			providerId: 'p',
			status: 503,
			body: '',
			shouldRetry: 'true',
		})
		expect(plain.shouldRetry).toBeUndefined()
		expect(classifyProviderError(plain).retryable).toBe(true)
	})
})

describe('the turn drops a restarted attempt', () => {
	const TURN_ID = '99b1ceae-1a8b-4b07-b56e-327eae34f058' as TurnId

	function makeLogger(): Logger {
		const stub = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		}
		return {
			...stub,
			child: vi.fn(() => ({ ...stub, child: vi.fn() })),
		} as unknown as Logger
	}

	it('answers with the second attempt alone and announces the restart', async () => {
		const { sleepFn } = recorder()
		const inner = {
			id: 'drops',
			name: 'Drops',
			capabilities: {},
			calls: 0,
			async *chatStream() {
				if (this.calls++ === 0) {
					yield { id: 'a', delta: { content: 'par' } }
					throw Object.assign(new Error('socket hang up'), {
						code: 'ECONNRESET',
					})
				}
				yield { id: 'b', delta: { content: 'whole answer' } }
				yield { id: 'b', delta: {}, finishReason: 'stop' as const }
			},
		}
		const provider = withProviderRetry(inner as unknown as LLMProvider, {
			config: REFERENCE,
			sleepFn,
			random: () => 0,
		})
		const events: SessionEvent[] = []
		const pending: SessionEvent[] = []
		const emitEvent = async (e: SessionEventDraft) => {
			events.push(e as SessionEvent)
			pending.push(e as SessionEvent)
		}
		const drainPending = function* (): Generator<SessionEvent> {
			while (pending.length > 0) {
				const next = pending.shift()
				if (next) yield next
			}
		}
		const gen = streamProviderTurn(
			provider,
			{ model: 'm', messages: [] } as never,
			emitEvent,
			drainPending,
			TURN_ID,
			1,
			false,
			makeLogger(),
		)
		let next = await gen.next()
		while (!next.done) next = await gen.next()
		expect(next.value.response.message.content).toBe('whole answer')
		const retry = events.find((e) => e.type === 'provider_retry')
		expect(retry).toMatchObject({ attempt: 1, maxRetries: 10, restart: true })
	})
})
