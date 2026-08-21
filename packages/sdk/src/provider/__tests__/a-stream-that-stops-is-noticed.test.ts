import { describe, expect, it, vi } from 'vitest'

import type { ChatCompletionParams, StreamChunk } from '../../types/provider/index.js'
import type { LLMProvider } from '../../types/provider/interface.js'
import { ProviderRequestError } from '../errors.js'
import { withStreamIdleTimeout } from '../idle-timeout.js'

/**
 * A stream that opens and then goes quiet trips nothing.
 *
 * Each driver has a whole-REQUEST timeout, and a stalled stream does not
 * reach it: the request succeeded, the bytes have simply stopped. One
 * driver had a per-chunk watchdog written inline, and it defaulted to OFF
 * — so zero of seven re-armed on a stall unless a host set a config key it
 * had no reason to know about.
 *
 * A run in that state is not slow, it is stuck: holding its budget, its
 * claim and its process, settling never. That is the failure a kernel with
 * checkpoints and budgets exists to make impossible.
 */

function chunk(text: string): StreamChunk {
	return { delta: { content: text } } as unknown as StreamChunk
}

/** Yields, then hangs forever on the chunk at `stallAt`. */
function stallingDriver(stallAt: number): LLMProvider {
	return {
		id: 'stalling',
		name: 'Stalling',
		async *chatStream(_params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			for (let i = 0; ; i++) {
				if (i === stallAt) await new Promise(() => {})
				yield chunk(`chunk ${i}`)
			}
		},
	} as unknown as LLMProvider
}

function finishingDriver(count: number): LLMProvider {
	return {
		id: 'finishing',
		name: 'Finishing',
		async *chatStream(_params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			for (let i = 0; i < count; i++) yield chunk(`chunk ${i}`)
		},
	} as unknown as LLMProvider
}

async function drainChunks(provider: LLMProvider): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const c of provider.chatStream({} as ChatCompletionParams)) out.push(c)
	return out
}

function abortRejectingDriver(observe: (signal: AbortSignal) => void): LLMProvider {
	return {
		id: 'abort-rejecting',
		name: 'Abort Rejecting',
		chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			const signal = params.signal
			if (!signal) throw new Error('expected a transport signal')
			observe(signal)
			return {
				[Symbol.asyncIterator]() {
					return {
						next: () =>
							new Promise<IteratorResult<StreamChunk>>((_resolve, reject) => {
								signal.addEventListener(
									'abort',
									() =>
										reject(
											Object.assign(new Error('transport aborted'), {
												name: 'AbortError',
											}),
										),
									{ once: true },
								)
							}),
						return: async () => ({ done: true, value: undefined }),
					}
				},
			}
		},
	}
}

describe('a stalled stream is surfaced', () => {
	it('fails with a network-classified error naming the idle duration', async () => {
		// `network`, not a new kind: retry and fallback already know how to
		// act on that classification, and a bespoke one would reach them as
		// an unknown they treat as fatal.
		vi.useFakeTimers()
		let caught: unknown
		try {
			const settled = drainChunks(
				withStreamIdleTimeout(stallingDriver(0), { idleTimeoutMs: 30_000 }),
			).catch((err: unknown) => {
				caught = err
			})
			await vi.advanceTimersByTimeAsync(30_001)
			await settled
		} finally {
			vi.useRealTimers()
		}

		expect(caught).toBeInstanceOf(ProviderRequestError)
		expect((caught as ProviderRequestError).message).toContain('30s')
	})

	it('names a sub-second bound exactly and aborts only the provider transport', async () => {
		vi.useFakeTimers()
		const caller = new AbortController()
		let transport: AbortSignal | undefined
		let caught: unknown
		try {
			const wrapped = withStreamIdleTimeout(
				abortRejectingDriver((signal) => {
					transport = signal
				}),
				{ idleTimeoutMs: 10 },
			)
			const settled = (async () => {
				for await (const _chunk of wrapped.chatStream({
					signal: caller.signal,
				} as never)) {
					// no chunks: the transport remains pending until the watchdog aborts it
				}
			})().catch((err: unknown) => {
				caught = err
			})

			await vi.advanceTimersByTimeAsync(11)
			await settled
		} finally {
			vi.useRealTimers()
		}

		expect(caught).toBeInstanceOf(ProviderRequestError)
		expect((caught as ProviderRequestError).kind).toBe('network')
		expect((caught as ProviderRequestError).message).toContain('10ms')
		expect(transport?.aborted).toBe(true)
		expect(transport?.reason).toBe(caught)
		expect(caller.signal.aborted).toBe(false)
	})

	it('preserves a caller abort that wins before the watchdog', async () => {
		const caller = new AbortController()
		const reason = new Error('operator stopped this turn')
		let transport: AbortSignal | undefined
		const wrapped = withStreamIdleTimeout(
			abortRejectingDriver((signal) => {
				transport = signal
			}),
			{ idleTimeoutMs: 30_000 },
		)
		const settled = (async () => {
			for await (const _chunk of wrapped.chatStream({
				signal: caller.signal,
			} as never)) {
				// no chunks: caller cancellation is the only settlement in this test
			}
		})()
		await Promise.resolve()

		caller.abort(reason)

		await expect(settled).rejects.toBe(reason)
		expect(transport?.aborted).toBe(true)
		expect(transport?.reason).toBe(reason)
	})

	it('re-arms per chunk, so a slow-but-alive stream is not killed', async () => {
		// The property that separates a watchdog from a deadline. A stream
		// producing steadily below the idle bound must survive indefinitely;
		// arming once at the start makes this a request timeout wearing a
		// different name.
		vi.useFakeTimers()
		try {
			const wrapped = withStreamIdleTimeout(finishingDriver(5), {
				idleTimeoutMs: 1_000,
			})
			const settled = drainChunks(wrapped)
			await vi.advanceTimersByTimeAsync(0)

			expect((await settled).length).toBe(5)
		} finally {
			vi.useRealTimers()
		}
	})

	it('clears its timer on the way out, however the stream ended', async () => {
		// A leaked timer per stalled stream keeps the process alive past the
		// run it belonged to. Clearing only on success leaks exactly the case
		// this decorator exists for.
		vi.useFakeTimers()
		const cleared: unknown[] = []
		try {
			const wrapped = withStreamIdleTimeout(finishingDriver(3), {
				idleTimeoutMs: 1_000,
				clearTimeoutFn: ((t: unknown) => {
					cleared.push(t)
					return clearTimeout(t as ReturnType<typeof setTimeout>)
				}) as typeof clearTimeout,
			})
			const settled = drainChunks(wrapped)
			await vi.advanceTimersByTimeAsync(0)
			await settled

			// One per pulled chunk plus the final `done` pull.
			expect(cleared.length).toBe(4)
		} finally {
			vi.useRealTimers()
		}
	})

	it('clears the timer on the STALL path too, which is the one that leaks', async () => {
		// The finishing case above clears on success. This is the case the
		// decorator exists for, and the one a `clearTimeout` in the success
		// branch alone would miss — every stalled stream leaving a live
		// timer that keeps the process alive past the run it belonged to.
		vi.useFakeTimers()
		const cleared: unknown[] = []
		try {
			const settled = drainChunks(
				withStreamIdleTimeout(stallingDriver(0), {
					idleTimeoutMs: 1_000,
					clearTimeoutFn: ((t: unknown) => {
						cleared.push(t)
						return clearTimeout(t as ReturnType<typeof setTimeout>)
					}) as typeof clearTimeout,
				}),
			).catch(() => {})
			await vi.advanceTimersByTimeAsync(1_001)
			await settled
		} finally {
			vi.useRealTimers()
		}

		expect(cleared.length).toBe(1)
	})

	it('returns the provider unwrapped when disabled', async () => {
		// Not wrapped-and-inert. A disabled watchdog that still races a
		// promise per chunk costs the hottest path in the runtime a timer and
		// a closure for nothing — asserted by identity, because a count
		// assertion cannot see it.
		const driver = finishingDriver(1)

		expect(withStreamIdleTimeout(driver, { idleTimeoutMs: 0 })).toBe(driver)
		expect(withStreamIdleTimeout(driver, { idleTimeoutMs: Number.NaN })).toBe(driver)
		expect(withStreamIdleTimeout(driver, { idleTimeoutMs: -1 })).toBe(driver)
	})

	it('keeps everything else about the provider', async () => {
		// Decorator, not replacement: `id`, `name` and any capability
		// declaration must survive, or wrapping a driver silently strips what
		// the runtime reads to decide whether to send tools.
		const driver = {
			...finishingDriver(1),
			capabilities: {
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
			},
		} as LLMProvider

		const wrapped = withStreamIdleTimeout(driver, { idleTimeoutMs: 1_000 })

		expect(wrapped.id).toBe(driver.id)
		expect(wrapped.name).toBe(driver.name)
		expect(wrapped.capabilities).toEqual(driver.capabilities)
	})

	it('keeps prototype methods and retry defaults rather than spreading a class', async () => {
		class ClassDriver implements LLMProvider {
			readonly id = 'class-driver'
			readonly name = 'Class Driver'
			readonly retryDefaults = { maxRetries: 0 }
			probed = false

			async *chatStream(): AsyncIterable<StreamChunk> {
				yield chunk('ok')
			}

			async listModels() {
				return [
					{
						id: 'class-model',
						name: 'Class Model',
						provider: this.id,
						inputPrice: 0,
						outputPrice: 0,
						supportsToolUse: true,
						supportsStreaming: true,
					},
				]
			}

			async probeCredential(): Promise<void> {
				this.probed = true
			}

			reasoningEffortLevelsFor(model: string) {
				return model === 'class-model' ? (['low'] as const) : undefined
			}
		}

		const driver = new ClassDriver()
		const wrapped = withStreamIdleTimeout(driver, { idleTimeoutMs: 1_000 })

		expect(wrapped.retryDefaults).toBe(driver.retryDefaults)
		expect(await wrapped.listModels?.()).toEqual([
			{
				id: 'class-model',
				name: 'Class Model',
				provider: 'class-driver',
				inputPrice: 0,
				outputPrice: 0,
				supportsToolUse: true,
				supportsStreaming: true,
			},
		])
		await wrapped.probeCredential?.()
		expect(driver.probed).toBe(true)
		expect(wrapped.reasoningEffortLevelsFor?.('class-model')).toEqual(['low'])
		expect(wrapped.reasoningEffortLevelsFor?.('future-model')).toBeUndefined()
	})
})
