// Current-code invariants asserted (2026-07-12, ses_015 Phase A):
// - attemptModelCall retries ONLY throttle|server|network ProviderRequestError
//   kinds; auth|bad_request|context_overflow|aborted|unknown and plain errors
//   are rethrown after a single attempt.
// - A server-advised retryAfterMs is honored verbatim as the backoff wait;
//   otherwise the wait is full-jitter exponential (random(0, min(base*2^(n-1),
//   maxDelayMs))) and each wait is additionally clamped to the deadline.
// - An abort during the backoff sleep rethrows kind 'aborted'; a signal already
//   aborted at entry rethrows kind 'aborted' before any provider call.
// - Reaching the run deadline stops the loop: pre-first-attempt it throws a
//   synthetic 'network' deadline error (no call made); mid-retry it rethrows the
//   last observed provider error so the caller can classify a timeout off the
//   shared clock.
// - onAttempt observer errors are logged and swallowed; the call still proceeds.
// - resolveRetryConfig falls back to DEFAULT_RETRY_CONFIG when runConfig.retry
//   is absent and returns the provided config otherwise.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RETRY_CONFIG } from '../../../config/runtime.js'
import { ProviderRequestError } from '../../../provider/errors.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	ProviderErrorKind,
} from '../../../types/provider/index.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import type { AgentRunConfig, RetryConfig } from '../../../types/run/index.js'
import type { Logger } from '../../../utils/logger.js'
import { attemptModelCall, resolveRetryConfig } from '../model-call.js'

function makeLogger(): Logger {
	const stub = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function okResponse(): ChatCompletionResponse {
	return {
		id: 'resp_1',
		model: 'test-model',
		message: { role: 'assistant', content: 'done' },
		finishReason: 'stop',
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	} as ChatCompletionResponse
}

interface FakeProvider extends LLMProvider {
	calls: ChatCompletionParams[]
}

function makeProvider(
	chatImpl: (params: ChatCompletionParams, call: number) => Promise<ChatCompletionResponse>,
): FakeProvider {
	const calls: ChatCompletionParams[] = []
	return {
		id: 'fake',
		name: 'Fake Provider',
		calls,
		async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			const index = calls.length
			calls.push(params)
			return chatImpl(params, index)
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked in these tests
		async *chatStream() {
			throw new Error('not used')
		},
	}
}

const RETRY: RetryConfig = {
	enabled: true,
	maxAttempts: 3,
	baseDelayMs: 0,
	maxDelayMs: 30_000,
	overflowAttempts: 2,
}

function err(kind: ProviderErrorKind, extra?: { retryAfterMs?: number }): ProviderRequestError {
	return new ProviderRequestError(`fail:${kind}`, { kind, providerId: 'fake', ...extra })
}

/** Replace setTimeout with a synchronous stub that records the requested delay. */
function captureDelays(): { delays: number[]; restore: () => void } {
	const delays: number[] = []
	const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
		cb: () => void,
		ms?: number,
	) => {
		delays.push(ms ?? 0)
		cb()
		return 0 as unknown as ReturnType<typeof setTimeout>
	}) as typeof setTimeout)
	return { delays, restore: () => spy.mockRestore() }
}

const FAR_DEADLINE = () => Date.now() + 10 * 60_000

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe('resolveRetryConfig', () => {
	it('falls back to DEFAULT_RETRY_CONFIG when retry is absent', () => {
		expect(resolveRetryConfig({ retry: undefined } as AgentRunConfig)).toBe(DEFAULT_RETRY_CONFIG)
	})

	it('returns the provided retry config verbatim', () => {
		const retry: RetryConfig = { ...DEFAULT_RETRY_CONFIG, maxAttempts: 9 }
		expect(resolveRetryConfig({ retry } as AgentRunConfig)).toBe(retry)
	})
})

describe('attemptModelCall — retry classification', () => {
	it.each(['throttle', 'server', 'network'] as ProviderErrorKind[])(
		'retries %s until success',
		async (kind) => {
			const provider = makeProvider(async (_p, call) => {
				if (call < 2) throw err(kind)
				return okResponse()
			})
			const res = await attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: RETRY,
				signal: new AbortController().signal,
				deadlineAt: FAR_DEADLINE(),
				log: makeLogger(),
			})
			expect(res.finishReason).toBe('stop')
			expect(provider.calls).toHaveLength(3)
		},
	)

	it.each(['auth', 'bad_request', 'context_overflow', 'unknown'] as ProviderErrorKind[])(
		'does not retry %s',
		async (kind) => {
			const thrown = err(kind)
			const provider = makeProvider(async () => {
				throw thrown
			})
			await expect(
				attemptModelCall({
					provider,
					params: { model: 'm', messages: [] },
					retry: RETRY,
					signal: new AbortController().signal,
					deadlineAt: FAR_DEADLINE(),
					log: makeLogger(),
				}),
			).rejects.toBe(thrown)
			expect(provider.calls).toHaveLength(1)
		},
	)

	it('does not retry a plain (non-ProviderRequestError) throw', async () => {
		const thrown = new Error('opaque')
		const provider = makeProvider(async () => {
			throw thrown
		})
		await expect(
			attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: RETRY,
				signal: new AbortController().signal,
				deadlineAt: FAR_DEADLINE(),
				log: makeLogger(),
			}),
		).rejects.toBe(thrown)
		expect(provider.calls).toHaveLength(1)
	})

	it('stops after maxAttempts and rethrows the last error', async () => {
		const provider = makeProvider(async () => {
			throw err('server')
		})
		await expect(
			attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: { ...RETRY, maxAttempts: 2 },
				signal: new AbortController().signal,
				deadlineAt: FAR_DEADLINE(),
				log: makeLogger(),
			}),
		).rejects.toMatchObject({ kind: 'server' })
		expect(provider.calls).toHaveLength(2)
	})

	it('makes exactly one attempt when retry is disabled', async () => {
		const provider = makeProvider(async () => {
			throw err('server')
		})
		await expect(
			attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: { ...RETRY, enabled: false },
				signal: new AbortController().signal,
				deadlineAt: FAR_DEADLINE(),
				log: makeLogger(),
			}),
		).rejects.toMatchObject({ kind: 'server' })
		expect(provider.calls).toHaveLength(1)
	})
})

describe('attemptModelCall — backoff timing', () => {
	it('honors retryAfterMs verbatim as the wait', async () => {
		const { delays, restore } = captureDelays()
		const provider = makeProvider(async (_p, call) => {
			if (call < 1) throw err('throttle', { retryAfterMs: 1234 })
			return okResponse()
		})
		await attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: { ...RETRY, baseDelayMs: 50 },
			signal: new AbortController().signal,
			deadlineAt: FAR_DEADLINE(),
			log: makeLogger(),
		})
		restore()
		expect(delays).toEqual([1234])
	})

	it('uses full-jitter exponential backoff within bounds', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5)
		const { delays, restore } = captureDelays()
		const provider = makeProvider(async (_p, call) => {
			if (call < 3) throw err('server')
			return okResponse()
		})
		await attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: { ...RETRY, maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 30_000 },
			signal: new AbortController().signal,
			deadlineAt: FAR_DEADLINE(),
			log: makeLogger(),
		})
		restore()
		// random=0.5 → 0.5 * min(1000*2^(n-1), maxDelay)
		expect(delays).toEqual([500, 1000, 2000])
	})

	it('caps computed backoff at maxDelayMs', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const { delays, restore } = captureDelays()
		const provider = makeProvider(async (_p, call) => {
			if (call < 3) throw err('server')
			return okResponse()
		})
		await attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: { ...RETRY, maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 1500 },
			signal: new AbortController().signal,
			deadlineAt: FAR_DEADLINE(),
			log: makeLogger(),
		})
		restore()
		expect(delays).toEqual([1000, 1500, 1500])
	})
})

describe('attemptModelCall — abort', () => {
	it('rethrows aborted when the signal is already aborted at entry', async () => {
		const controller = new AbortController()
		controller.abort()
		const provider = makeProvider(async () => okResponse())
		await expect(
			attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: RETRY,
				signal: controller.signal,
				deadlineAt: FAR_DEADLINE(),
				log: makeLogger(),
			}),
		).rejects.toMatchObject({ kind: 'aborted' })
		expect(provider.calls).toHaveLength(0)
	})

	it('rethrows aborted when the signal fires during the backoff sleep', async () => {
		const controller = new AbortController()
		const provider = makeProvider(async () => {
			throw err('server')
		})
		const promise = attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: { ...RETRY, baseDelayMs: 100, maxDelayMs: 100 },
			signal: controller.signal,
			deadlineAt: FAR_DEADLINE(),
			log: makeLogger(),
		})
		setTimeout(() => controller.abort(), 5)
		await expect(promise).rejects.toMatchObject({ kind: 'aborted' })
		expect(provider.calls).toHaveLength(1)
	})
})

describe('attemptModelCall — deadline', () => {
	it('throws a network deadline error without calling the provider when already past', async () => {
		const provider = makeProvider(async () => okResponse())
		await expect(
			attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: RETRY,
				signal: new AbortController().signal,
				deadlineAt: Date.now() - 1,
				log: makeLogger(),
			}),
		).rejects.toMatchObject({ kind: 'network' })
		expect(provider.calls).toHaveLength(0)
	})

	it('rethrows the last error when the deadline is reached mid-retry', async () => {
		vi.useFakeTimers({ now: 0 })
		// Pin jitter to 1 so the first backoff consumes the full remaining budget
		// (min(base, remaining)=500); otherwise a shorter wait could fit a second
		// attempt before the deadline.
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const thrown = err('server')
		const provider = makeProvider(async () => {
			throw thrown
		})
		const promise = attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: { ...RETRY, maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000 },
			signal: new AbortController().signal,
			deadlineAt: 500,
			log: makeLogger(),
		})
		const assertion = expect(promise).rejects.toBe(thrown)
		await vi.advanceTimersByTimeAsync(500)
		await assertion
		expect(provider.calls).toHaveLength(1)
	})
})

describe('attemptModelCall — onAttempt isolation', () => {
	it('logs and swallows an observer that throws, then proceeds', async () => {
		const log = makeLogger()
		const provider = makeProvider(async () => okResponse())
		const seen: number[] = []
		const res = await attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: RETRY,
			signal: new AbortController().signal,
			deadlineAt: FAR_DEADLINE(),
			log,
			onAttempt: ({ attempt }) => {
				seen.push(attempt)
				throw new Error('observer boom')
			},
		})
		expect(res.finishReason).toBe('stop')
		expect(seen).toEqual([1])
		expect(log.warn).toHaveBeenCalledTimes(1)
	})
})
