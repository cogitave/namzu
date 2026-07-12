// Current-code invariants asserted (2026-07-12, ses_015 Phase A):
// - attemptModelCall retries ONLY throttle|server|network ProviderRequestError
//   kinds; auth|bad_request|context_overflow|aborted|unknown and plain errors
//   are rethrown after a single attempt.
// - A server-advised retryAfterMs is honored as the backoff wait but clamped to
//   retry.maxDelayMs (ses_015 fix-batch), so a hostile/misparsed hours-long
//   Retry-After cannot stall the loop; otherwise the wait is full-jitter
//   exponential (random(0, min(base*2^(n-1), maxDelayMs))) and each wait is
//   additionally clamped to the deadline.
// - An abort during the backoff sleep rethrows kind 'aborted'; a signal already
//   aborted at entry rethrows kind 'aborted' before any provider call.
// - Reaching the run deadline stops the loop: pre-first-attempt it throws a
//   synthetic 'network' deadline error (no call made); mid-retry it rethrows the
//   last observed provider error so the caller can classify a timeout off the
//   shared clock.
// - onAttempt observer errors are logged and swallowed; the call still proceeds.
// - resolveRetryConfig falls back to DEFAULT_RETRY_CONFIG when runConfig.retry
//   is absent and returns the provided config otherwise.
//
// Current-code invariants asserted (2026-07-12, ses_015 pre-freeze B2):
// - deadlineAt bounds the IN-FLIGHT call, not merely the attempt count: a
//   provider that never returns is abandoned at the deadline with a retryable
//   'network' kind (so the loop's timeout branch fires), is not retried
//   afterwards, and a late response arriving after the wait was abandoned cannot
//   resolve the call.
// - An abort mid-flight rejects with kind 'aborted'; the signal is still
//   forwarded to the provider so an abortable adapter tears the request down.
//
// Current-code invariants asserted (2026-07-12, pre-freeze round 3):
// - A provider whose chat() throws SYNCHRONOUSLY is treated exactly like one that
//   rejects: same classification, same retry decision — and, critically, the same
//   teardown. The race's deadline timer and abort listener are installed before
//   the call and released in a finally, so no attempt can leak either. A leaked
//   deadline timer holds the full remaining run budget and keeps the process
//   alive; retries multiplied them.
// - The deadline is re-read immediately before the physical request is issued, so
//   a clock that crosses during the onAttempt observer means no request goes out
//   at all, rather than one issued into a spent budget and raced against a
//   zero-delay timer.
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
import { attemptModelCall, isRetryableKind, resolveRetryConfig } from '../model-call.js'

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

/**
 * Replace setTimeout with a synchronous stub that records the requested delay.
 *
 * Two things schedule timers under `attemptModelCall`: the backoff sleep, and the
 * in-flight deadline installed per attempt by `callWithinDeadline` (pre-freeze
 * B2). Only the first is under test here. The deadline timers carry the full
 * remaining run budget, so anything at or above `ignoreAtOrAbove` is neither
 * recorded nor fired — every test in this block runs against FAR_DEADLINE, and
 * firing that timer synchronously would abandon the call before the provider
 * could answer.
 */
function captureDelays(ignoreAtOrAbove = 60_000): { delays: number[]; restore: () => void } {
	const delays: number[] = []
	const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
		cb: () => void,
		ms?: number,
	) => {
		const delay = ms ?? 0
		if (delay >= ignoreAtOrAbove) return 0 as unknown as ReturnType<typeof setTimeout>
		delays.push(delay)
		cb()
		return 0 as unknown as ReturnType<typeof setTimeout>
	}) as typeof setTimeout)
	return { delays, restore: () => spy.mockRestore() }
}

const FAR_DEADLINE = () => Date.now() + 10 * 60_000

afterEach(() => {
	// Fake timers must come off BEFORE the spies are restored. Reversed, a spy on
	// globalThis.setTimeout is written back while the fake clock still owns the
	// global, and the next real-timer test sees setTimeout undefined.
	vi.useRealTimers()
	vi.restoreAllMocks()
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

	it('clamps a server-advised retryAfterMs to maxDelayMs', async () => {
		const { delays, restore } = captureDelays()
		// A hostile / misparsed Retry-After far above the configured ceiling.
		const provider = makeProvider(async (_p, call) => {
			if (call < 1) throw err('throttle', { retryAfterMs: 3_600_000 })
			return okResponse()
		})
		await attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: { ...RETRY, baseDelayMs: 1000, maxDelayMs: 30_000 },
			signal: new AbortController().signal,
			deadlineAt: FAR_DEADLINE(),
			log: makeLogger(),
		})
		restore()
		expect(delays).toEqual([30_000])
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
		// The backoff is FULL JITTER — random(0, capped) — so with a 100ms cap it lands
		// under the 5ms abort about 5% of the time, the sleep finishes first, a second
		// attempt goes out and the one-call assertion below fails. That made this a
		// pre-existing ~5%-flaky test (it fired during the ses_015 pre-freeze gate run).
		// Pinning the jitter keeps the abort strictly inside the sleep, which is the
		// thing under test; the jitter itself is asserted in the backoff block above.
		vi.spyOn(Math, 'random').mockReturnValue(0.99)
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

	// ses_015 pre-freeze R4 m1. The deadline is live when callWithinDeadline reads the
	// clock and spent by the time armDeadline re-reads it a statement later — one
	// millisecond of real time between two adjacent lines is all that takes. The
	// promise settles through abandonWait either way, but execution carried straight
	// on and still issued the physical request: a result the settled promise can never
	// deliver, paid for in a round trip and, on a provider that cannot be aborted, in
	// tokens.
	it('does not issue a request when the deadline crosses between the check and the arm', async () => {
		const provider = makeProvider(async () => okResponse())
		const now = vi.spyOn(Date, 'now')
		now.mockReturnValueOnce(999) // attempt-loop deadline check: still live
		now.mockReturnValueOnce(999) // callWithinDeadline: remaining = 1ms
		now.mockReturnValue(1_000) // armDeadline's re-read onwards: spent

		await expect(
			attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: RETRY,
				signal: new AbortController().signal,
				deadlineAt: 1_000,
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

describe('attemptModelCall — the in-flight call is bounded, not just the attempts', () => {
	it('abandons a provider that never returns once the deadline elapses', async () => {
		vi.useFakeTimers({ now: 0 })
		// A provider that hangs forever: the pre-attempt deadline check cannot see
		// it, because it is only reached once the await resolves. Before the bound,
		// this run waited indefinitely and blew straight past timeoutMs.
		const provider = makeProvider(() => new Promise<ChatCompletionResponse>(() => {}))

		const promise = attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: RETRY,
			signal: new AbortController().signal,
			deadlineAt: 5_000,
			log: makeLogger(),
		})

		// Classified as a retryable transport kind so the iteration catch's timeout
		// branch fires and the run stops as 'timeout' rather than 'failed'.
		const assertion = expect(promise).rejects.toMatchObject({ kind: 'network' })
		await vi.advanceTimersByTimeAsync(5_000)
		await assertion
		expect(provider.calls).toHaveLength(1)
	})

	it('does not retry after the deadline abandons an attempt', async () => {
		vi.useFakeTimers({ now: 0 })
		const provider = makeProvider(() => new Promise<ChatCompletionResponse>(() => {}))

		const promise = attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: { ...RETRY, maxAttempts: 5 },
			signal: new AbortController().signal,
			deadlineAt: 1_000,
			log: makeLogger(),
		})

		const assertion = expect(promise).rejects.toMatchObject({ kind: 'network' })
		await vi.advanceTimersByTimeAsync(60_000)
		await assertion
		expect(provider.calls).toHaveLength(1)
	})

	it('abandons an in-flight call when the signal aborts, with kind aborted', async () => {
		const ctrl = new AbortController()
		const provider = makeProvider(() => new Promise<ChatCompletionResponse>(() => {}))

		const promise = attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: RETRY,
			signal: ctrl.signal,
			deadlineAt: FAR_DEADLINE(),
			log: makeLogger(),
		})

		// Wait until the request is genuinely in flight before aborting. Aborting
		// earlier is a different case — the request is never issued at all — and it is
		// covered in the settle-ordering block below.
		await vi.waitFor(() => expect(provider.calls).toHaveLength(1))

		ctrl.abort()
		await expect(promise).rejects.toMatchObject({ kind: 'aborted' })
		expect(provider.calls).toHaveLength(1)
	})

	it('ignores a late response from a provider whose wait was already abandoned', async () => {
		vi.useFakeTimers({ now: 0 })
		// The Ollama case: the request cannot be cancelled and eventually answers.
		// The bound promises only that the LOOP stopped waiting — the late value
		// must not resolve the call and flow on into hooks and tools.
		let settle: ((r: ChatCompletionResponse) => void) | undefined
		const provider = makeProvider(
			() =>
				new Promise<ChatCompletionResponse>((resolve) => {
					settle = resolve
				}),
		)

		const promise = attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: { ...RETRY, enabled: false },
			signal: new AbortController().signal,
			deadlineAt: 2_000,
			log: makeLogger(),
		})

		const assertion = expect(promise).rejects.toMatchObject({ kind: 'network' })
		await vi.advanceTimersByTimeAsync(2_000)
		await assertion

		settle?.(okResponse())
		await expect(promise).rejects.toMatchObject({ kind: 'network' })
	})

	it('forwards the signal to the provider so an abortable adapter can cancel', async () => {
		const ctrl = new AbortController()
		const provider = makeProvider(async () => okResponse())

		await attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: RETRY,
			signal: ctrl.signal,
			deadlineAt: FAR_DEADLINE(),
			log: makeLogger(),
		})

		expect(provider.calls[0]?.signal).toBe(ctrl.signal)
	})

	// ses_015 pre-freeze R2. Real timers on purpose: the defect IS Node's own
	// setTimeout clamping, and a fake clock does not reproduce it. `setTimeout(cb,
	// d)` with d > 2^31-1 overflows the signed 32-bit delay and Node clamps it to
	// 1 ms (TimeoutOverflowWarning), so the deadline timer fired ~1 ms into every
	// call: a healthy provider was abandoned as 'network', all three attempts burned
	// on the same clamp, and the run FAILED — not even classified as a timeout,
	// since the real deadline was still a month out.
	it('does not abandon the call when the deadline is past the 32-bit timer ceiling', async () => {
		const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000
		expect(THIRTY_DAYS_MS).toBeGreaterThan(2_147_483_647)

		const provider = makeProvider(
			() =>
				new Promise<ChatCompletionResponse>((resolve) => {
					setTimeout(() => resolve(okResponse()), 30)
				}),
		)

		const res = await attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: RETRY,
			signal: new AbortController().signal,
			deadlineAt: Date.now() + THIRTY_DAYS_MS,
			log: makeLogger(),
		})

		// The call answers normally and is not retried: the clamped timer never fires.
		expect(res.finishReason).toBe('stop')
		expect(provider.calls).toHaveLength(1)
	})

	it('emits no TimeoutOverflowWarning for an over-ceiling deadline', async () => {
		const warnings: string[] = []
		const onWarning = (w: Error): void => {
			warnings.push(w.name)
		}
		process.on('warning', onWarning)
		try {
			const provider = makeProvider(async () => okResponse())
			await attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: RETRY,
				signal: new AbortController().signal,
				// Infinity is accepted by the runtime config schema (z.number().positive()),
				// and it is the worst case for the naive timer: NaN/overflowing delay, 1 ms.
				deadlineAt: Number.POSITIVE_INFINITY,
				log: makeLogger(),
			})
			// Warnings are emitted on a later tick than the setTimeout call.
			await new Promise((r) => setImmediate(r))
			expect(warnings).not.toContain('TimeoutOverflowWarning')
		} finally {
			process.off('warning', onWarning)
		}
	})
})

/**
 * ses_015 pre-freeze R5 B1. Abort and deadline are STOP signals, not candidates in
 * a race they can lose.
 *
 * They could lose it. The abort listener did not settle the call; it scheduled a
 * zero-delay TIMER that settled it. `provider.chat` is invoked from a MICROTASK, and
 * every microtask runs before any timer — so an abort delivered after
 * `callWithinDeadline` returned was recorded, queued, and then beaten to the settle
 * by the very request it was supposed to prevent. On a fast provider the response
 * won outright and the loop carried on working for a run the caller had cancelled;
 * on a slow one the request still went out, and on an adapter that ignores the
 * signal (Ollama's non-streaming `chat()`) it was billed all the same.
 *
 * The deadline had the same hole from the other side: its timer cannot fire before
 * the invocation microtask either, so a budget that expired in the gap issued the
 * request anyway and only abandoned the wait afterwards.
 *
 * Both are now re-read in the invocation callback itself, immediately before the
 * request would leave the process, and the abort rejects in its own tick.
 */
describe('attemptModelCall — abort and deadline settle ahead of the provider', () => {
	it('never issues the request when the abort lands right after the call is entered', async () => {
		const ctrl = new AbortController()
		const provider = makeProvider(async () => okResponse())

		const promise = attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: RETRY,
			signal: ctrl.signal,
			deadlineAt: FAR_DEADLINE(),
			log: makeLogger(),
		})

		// Synchronous: the executor has installed the listener and queued the
		// invocation microtask, which has not run yet. Under the timer-deferred abort
		// this ordering issued the request and let a fast answer win.
		ctrl.abort()

		await expect(promise).rejects.toMatchObject({ kind: 'aborted' })
		expect(provider.calls).toHaveLength(0)
	})

	it("rejects as aborted when the abort lands while a fast provider is resolving — the provider's value does not win", async () => {
		const ctrl = new AbortController()
		// The provider cancels the run itself (a hook, a host, a user hitting ctrl-c
		// while the request is on the wire) and answers in the same breath. The answer
		// came after the abort; it does not get to overturn it.
		const provider = makeProvider(async () => {
			ctrl.abort()
			return okResponse()
		})

		const promise = attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: RETRY,
			signal: ctrl.signal,
			deadlineAt: FAR_DEADLINE(),
			log: makeLogger(),
		})

		await expect(promise).rejects.toMatchObject({ kind: 'aborted' })
		// The request WAS issued — this is the in-flight case — but its response is
		// discarded rather than flowing on into hooks, tools, and the history.
		expect(provider.calls).toHaveLength(1)
	})

	it('never issues the request when the deadline expires in the microtask gap', async () => {
		// The gap is invisible to a clock the test cannot step, so the clock is the
		// test's. Reads 1-3 are the retry loop's guard, the entry check, and armDeadline
		// — all inside the budget. The 4th read is the gate in the invocation callback,
		// one microtask later, and by then the budget is spent.
		const now = vi.spyOn(Date, 'now')
		now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0)
		now.mockReturnValue(5_000)

		const provider = makeProvider(async () => okResponse())

		const promise = attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: RETRY,
			signal: new AbortController().signal,
			deadlineAt: 1_000,
			log: makeLogger(),
		})

		// 'network', not 'aborted': a spent budget is what the loop classifies as a
		// timeout (retryable transport kind + a deadline that has passed), not a cancel.
		await expect(promise).rejects.toMatchObject({ kind: 'network' })
		// Not "issued and then ignored" — never issued. An adapter that cannot honor
		// the signal bills for every request it is handed, whoever stops waiting for it.
		expect(provider.calls).toHaveLength(0)
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

	// ses_015 pre-freeze R4 B1. The attempt loop checks `signal.aborted`, THEN runs
	// the observer, and only then does the race install its abort listener — and
	// `addEventListener` does not replay an abort that already fired. An abort raised
	// inside the observer was therefore observed by nobody: the listener never fired,
	// and the loop waited on a provider that may ignore the forwarded signal until the
	// deadline, instead of being cancelled promptly.
	it('rejects as aborted, and issues no request, when the observer aborts the signal', async () => {
		const ctrl = new AbortController()
		const provider = makeProvider(async () => okResponse())

		await expect(
			attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: RETRY,
				signal: ctrl.signal,
				deadlineAt: FAR_DEADLINE(),
				log: makeLogger(),
				onAttempt: () => ctrl.abort(),
			}),
		).rejects.toMatchObject({ kind: 'aborted' })

		expect(provider.calls).toHaveLength(0)
	})

	it('does not issue a request when the deadline crosses during the observer', async () => {
		vi.useFakeTimers({ now: 0 })
		// The observer is host code and takes whatever time it takes. The deadline was
		// live when the attempt loop checked it and is spent by the time the request
		// would go out — so the request must not go out at all: it could only be
		// raced against a zero-delay timer and thrown away, having cost a round trip
		// and, on a provider that cannot be aborted, the tokens too.
		const provider = makeProvider(async () => okResponse())

		const promise = attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: RETRY,
			signal: new AbortController().signal,
			deadlineAt: 1_000,
			log: makeLogger(),
			onAttempt: () => {
				vi.setSystemTime(1_500)
			},
		})

		await expect(promise).rejects.toMatchObject({ kind: 'network' })
		expect(provider.calls).toHaveLength(0)
	})
})

describe('attemptModelCall — a backoff past the 32-bit timer ceiling', () => {
	// ses_015 pre-freeze R4 M1. Real timers on purpose: the defect IS Node's own
	// setTimeout clamp, and a fake clock does not reproduce it. RetryConfigSchema
	// accepts any non-negative maxDelayMs — Infinity included — and a server-advised
	// retryAfterMs is clamped only to that ceiling, so the delay handed to setTimeout
	// can exceed 2^31-1 ms, where Node silently clamps it to 1 ms. The configuration
	// asking the loop to back off hardest was the one that made it retry instantly,
	// hammering the throttled provider that asked for the wait.
	it('does not collapse an over-ceiling backoff into an immediate retry', async () => {
		const OVER_CEILING_MS = 3_000_000_000
		expect(OVER_CEILING_MS).toBeGreaterThan(2_147_483_647)

		const warnings: string[] = []
		const onWarning = (w: Error): void => {
			warnings.push(w.name)
		}
		process.on('warning', onWarning)

		const ctrl = new AbortController()
		const provider = makeProvider(async () => {
			throw err('throttle', { retryAfterMs: OVER_CEILING_MS })
		})

		try {
			const promise = attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: { ...RETRY, maxAttempts: 3, maxDelayMs: OVER_CEILING_MS },
				signal: ctrl.signal,
				deadlineAt: Date.now() + 10 * OVER_CEILING_MS,
				log: makeLogger(),
			})

			// Under the clamp the sleep wakes ~1 ms in and attempt 2 goes straight back
			// out. 50 ms of real time is orders of magnitude more than that needs.
			await new Promise((r) => setTimeout(r, 50))
			expect(provider.calls).toHaveLength(1)
			// Warnings land a tick after the setTimeout call that provoked them.
			await new Promise((r) => setImmediate(r))
			expect(warnings).not.toContain('TimeoutOverflowWarning')

			// The sliced sleep must still race the signal, or cancelling a run would hang
			// for the whole 24.8-day slice.
			ctrl.abort()
			await expect(promise).rejects.toMatchObject({ kind: 'aborted' })
			expect(provider.calls).toHaveLength(1)
		} finally {
			process.off('warning', onWarning)
		}
	})
})

describe('attemptModelCall — a provider that throws synchronously', () => {
	/**
	 * `chat()` is typed to return a promise, but nothing stops a conforming adapter
	 * from validating its params first and throwing before it ever gets there. The
	 * race installed its deadline timer and abort listener BEFORE calling `chat()`,
	 * and hung their teardown off the settle path — which a synchronous throw skips
	 * entirely, because it rejects the promise from inside the executor. Every such
	 * attempt leaked a live timer holding the full remaining run budget, and a live
	 * abort listener, and retries multiplied them.
	 */
	function makeThrowingProvider(toThrow: unknown): { provider: LLMProvider; calls: () => number } {
		let calls = 0
		const provider: LLMProvider = {
			id: 'fake',
			name: 'Fake Provider',
			// Deliberately NOT `async`: an async function converts a throw into a
			// rejection, which is the path that already worked.
			chat(): Promise<ChatCompletionResponse> {
				calls++
				throw toThrow
			},
			// biome-ignore lint/correctness/useYield: stub, never invoked in these tests
			async *chatStream() {
				throw new Error('not used')
			},
		}
		return { provider, calls: () => calls }
	}

	it('classifies and retries it exactly as it would an async rejection', async () => {
		const { provider, calls } = makeThrowingProvider(err('server'))

		await expect(
			attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: { ...RETRY, baseDelayMs: 0 },
				signal: new AbortController().signal,
				deadlineAt: FAR_DEADLINE(),
				log: makeLogger(),
			}),
		).rejects.toMatchObject({ kind: 'server' })

		expect(calls()).toBe(3)
	})

	it('leaves no timer and no listener behind, on any attempt', async () => {
		vi.useFakeTimers({ now: 0 })
		const ctrl = new AbortController()
		const added = vi.spyOn(ctrl.signal, 'addEventListener')
		const removed = vi.spyOn(ctrl.signal, 'removeEventListener')
		const { provider, calls } = makeThrowingProvider(err('server'))

		await expect(
			attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: { ...RETRY, baseDelayMs: 0 },
				signal: ctrl.signal,
				deadlineAt: 10 * 60_000,
				log: makeLogger(),
			}),
		).rejects.toMatchObject({ kind: 'server' })

		expect(calls()).toBe(3)
		// One deadline timer per attempt was installed, each holding the full run
		// budget. None may survive the call — a leaked one keeps the process alive.
		expect(vi.getTimerCount()).toBe(0)
		expect(added).toHaveBeenCalledTimes(3)
		expect(removed).toHaveBeenCalledTimes(3)
	})

	it('propagates a non-provider synchronous throw unretried', async () => {
		const { provider, calls } = makeThrowingProvider(new TypeError('params.model is required'))

		await expect(
			attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: RETRY,
				signal: new AbortController().signal,
				deadlineAt: FAR_DEADLINE(),
				log: makeLogger(),
			}),
		).rejects.toThrow(TypeError)

		expect(calls()).toBe(1)
	})
})

/**
 * ses_015 pre-freeze R6 B1. The deadline was checked on the way OUT — before the
 * request was issued — and never on the way BACK IN.
 *
 * The timer is not a backstop for that. A provider that blocks SYNCHRONOUSLY past
 * the deadline (a local model, a slow tokenizer, a large JSON parse) owns the event
 * loop for the whole overrun, so the timer — a macrotask — cannot run; and when the
 * provider finally hands back an already-fulfilled promise, the reaction to it is a
 * MICROTASK, which runs ahead of the overdue timer. The response won a race it had
 * already lost on the clock, and went on to be accounted, hooked, and appended.
 */
describe('attemptModelCall — the deadline is enforced when the response ARRIVES', () => {
	it('discards the response of a provider that blocked synchronously past the deadline', async () => {
		// The clock is the test's, so the overrun is exact rather than timing-dependent.
		let clock = 0
		vi.spyOn(Date, 'now').mockImplementation(() => clock)
		const deadlineAt = 1_000

		// The block: the budget is spent INSIDE chat(), and the promise it returns is
		// already fulfilled. No timer had a chance to fire.
		const provider = makeProvider(async () => {
			clock = deadlineAt + 5
			return okResponse()
		})

		const promise = attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: RETRY,
			signal: new AbortController().signal,
			deadlineAt,
			log: makeLogger(),
		})

		// Not the response. The same rejection the timer would have produced, had it
		// been able to run — and a RETRYABLE transport kind, which is the half of
		// `isDeadlineTimeoutStop` that makes the iteration classify the stop as a
		// timeout rather than a failure.
		const rejection = await promise.then(
			() => undefined,
			(e: unknown) => e as ProviderRequestError,
		)
		expect(rejection).toBeInstanceOf(ProviderRequestError)
		expect(rejection?.kind).toBe('network')
		expect(isRetryableKind(rejection?.kind ?? '')).toBe(true)
		expect(rejection?.message).toContain('exceeded the run deadline')

		// Issued once and not retried: the budget was already spent when it came back.
		expect(provider.calls).toHaveLength(1)
	})

	it('still accepts a response that arrives with the budget intact', async () => {
		// The other side of the guard. It rejects an OVERDUE response, not every
		// response — a clock re-read that is wrong by a sign would pass the test above
		// and break every healthy call.
		let clock = 0
		vi.spyOn(Date, 'now').mockImplementation(() => clock)

		const provider = makeProvider(async () => {
			clock = 999 // slow, but inside the budget
			return okResponse()
		})

		const response = await attemptModelCall({
			provider,
			params: { model: 'm', messages: [] },
			retry: RETRY,
			signal: new AbortController().signal,
			deadlineAt: 1_000,
			log: makeLogger(),
		})

		expect(response.message.content).toBe('done')
		expect(provider.calls).toHaveLength(1)
	})
})

/**
 * ses_015 pre-freeze R6 m1. Two stop conditions can be true at the same instant:
 * `onAttempt` is a host observer, and an abort raised inside it can coincide with
 * the deadline coming due. Whichever the call inspects first is what the run is
 * reported as — and it read the clock first, so a user hitting ctrl-c came back as
 * a `network` transport fault. The catch rethrows it verbatim (it sees
 * `signal.aborted` and does not retry), so the wrong kind travelled all the way out.
 */
describe('attemptModelCall — an abort that coincides with the deadline is an abort', () => {
	it('classifies as aborted when the observer aborts AND the deadline crosses', async () => {
		const ctrl = new AbortController()
		// Reads 1-2 are the retry loop's own guards, inside the budget. The observer
		// then aborts and burns the rest of the clock, so every read after it — the
		// entry check in callWithinDeadline included — is past the deadline.
		const now = vi.spyOn(Date, 'now')
		now.mockReturnValueOnce(0).mockReturnValueOnce(0)
		now.mockReturnValue(5_000)

		const provider = makeProvider(async () => okResponse())

		await expect(
			attemptModelCall({
				provider,
				params: { model: 'm', messages: [] },
				retry: RETRY,
				signal: ctrl.signal,
				deadlineAt: 1_000,
				log: makeLogger(),
				onAttempt: () => ctrl.abort(),
			}),
		).rejects.toMatchObject({ kind: 'aborted' })

		expect(provider.calls).toHaveLength(0)
	})
})
