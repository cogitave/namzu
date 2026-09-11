import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	OperationDeadline,
	OperationDeadlineExpired,
	probeHttpHealth,
	resolveReadinessOptions,
	runFailureCleanup,
} from './readiness.js'
import { REMOTE_EXECUTION_PROTOCOL_VERSION } from './remote-execution-controller.js'

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe('readiness option validation', () => {
	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
		'refuses an invalid timeout %s before work begins',
		(value) => {
			expect(() =>
				resolveReadinessOptions('worker', value, 10, {
					timeoutMs: 100,
					pollIntervalMs: 10,
				}),
			).toThrow(/worker\.readyTimeoutMs/)
		},
	)

	it('names an invalid poll interval independently', () => {
		expect(() =>
			resolveReadinessOptions('worker', 100, 0, {
				timeoutMs: 100,
				pollIntervalMs: 10,
			}),
		).toThrow(/worker\.readyPollIntervalMs/)
	})
})

describe('OperationDeadline', () => {
	it('settles even when the foreign promise ignores its abort signal', async () => {
		vi.useFakeTimers()
		let transportSignal: AbortSignal | undefined
		const deadline = new OperationDeadline(25, 'held health request')
		const pending = deadline.run(
			(signal) =>
				new Promise<never>(() => {
					transportSignal = signal
				}),
		)
		const rejected = expect(pending).rejects.toBeInstanceOf(OperationDeadlineExpired)

		await vi.advanceTimersByTimeAsync(25)
		await rejected
		expect(transportSignal?.aborted).toBe(true)
	})

	it('caps a retry delay by the remaining operation budget', async () => {
		vi.useFakeTimers()
		const deadline = new OperationDeadline(20, 'retry delay')
		const pending = deadline.delay(5_000)
		const rejected = expect(pending).rejects.toBeInstanceOf(OperationDeadlineExpired)

		await vi.advanceTimersByTimeAsync(20)
		await rejected
	})

	it('refuses a result that settles after the monotonic deadline', async () => {
		vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(11)
		const deadline = new OperationDeadline(10, 'late publication')

		await expect(deadline.run(async () => 'late-ready')).rejects.toBeInstanceOf(
			OperationDeadlineExpired,
		)
	})
})

describe('HTTP worker protocol readiness', () => {
	it('accepts only the exact remote execution protocol', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					protocolVersion: REMOTE_EXECUTION_PROTOCOL_VERSION,
				}),
				{ status: 200 },
			),
		)

		await expect(
			probeHttpHealth('http://worker.test/healthz', new AbortController().signal),
		).resolves.toEqual({ ok: true, status: 200 })
	})

	it.each([
		['missing', { ok: true }],
		['older', { ok: true, protocolVersion: REMOTE_EXECUTION_PROTOCOL_VERSION - 1 }],
		['newer', { ok: true, protocolVersion: REMOTE_EXECUTION_PROTOCOL_VERSION + 1 }],
	])('refuses a %s worker protocol', async (_label, payload) => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(payload), { status: 200 }),
		)

		await expect(
			probeHttpHealth('http://worker.test/healthz', new AbortController().signal),
		).rejects.toThrow(/protocol version/i)
	})
})

describe('failure cleanup', () => {
	it('aborts and detaches cleanup that ignores its grace', async () => {
		vi.useFakeTimers()
		let cleanupSignal: AbortSignal | undefined
		const pending = runFailureCleanup(
			(signal) =>
				new Promise<void>(() => {
					cleanupSignal = signal
				}),
			10,
		)

		await vi.advanceTimersByTimeAsync(10)
		await expect(pending).resolves.toBeUndefined()
		expect(cleanupSignal?.aborted).toBe(true)
	})
})
