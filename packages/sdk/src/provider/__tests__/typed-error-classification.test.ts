import { describe, expect, it } from 'vitest'

import { classifyProviderError } from '../../types/provider/errors.js'
import type { LLMProvider, StreamChunk } from '../../types/provider/index.js'
import { ProviderRequestError } from '../errors.js'
import { withProviderRetry } from '../retry.js'

/**
 * A driver that classified its own failure was coming out WORSE than one that
 * did not, in two independent places, and both shipped.
 *
 * `classifyProviderError` never read `kind`. A `ProviderRequestError` fell
 * through to the status heuristics, where a carefully-diagnosed
 * `context_overflow` carrying a 400 became `invalid_request` — so the run
 * loop's overflow branch, which tests for `context_length_exceeded`, could
 * never fire for a first-party driver, and compaction relief was unreachable
 * for exactly the drivers that had diagnosed the problem correctly.
 *
 * And `withProviderRetry` rethrew any such error before the retry loop. Its
 * comment justified preserving the classification, which is right; the code
 * also skipped retrying, which is a different decision that nobody made.
 */

function providerThatFails(err: unknown): { provider: LLMProvider; calls: () => number } {
	let calls = 0
	const provider = {
		id: 'test',
		name: 'Test',
		async *chatStream(): AsyncIterable<StreamChunk> {
			calls++
			throw err
			// biome-ignore lint/correctness/useYield: it fails before producing anything
		},
	} as unknown as LLMProvider
	return { provider, calls: () => calls }
}

const typed = (kind: string, status: number) =>
	new ProviderRequestError({ kind, providerId: 'test', status, message: `a ${kind}` } as never)

describe('a driver that classified its own failure is believed', () => {
	const cases: readonly [string, number, string, boolean][] = [
		['throttle', 429, 'rate_limit', true],
		['server', 500, 'server_error', true],
		['network', 0, 'network', true],
		['auth', 401, 'auth', false],
		['bad_request', 400, 'invalid_request', false],
		// The one that mattered most: a 400 whose kind says the prompt was too
		// long is not a bad request, and the difference decides whether the
		// kernel reaches for compaction.
		['context_overflow', 400, 'context_length_exceeded', false],
	]

	for (const [kind, status, code, retryable] of cases) {
		it(`maps kind "${kind}" to ${code}`, () => {
			const classified = classifyProviderError(typed(kind, status), 'test')
			expect(classified.code).toBe(code)
			expect(classified.retryable).toBe(retryable)
		})
	}

	it('keeps the driver-supplied status and provider id', () => {
		const classified = classifyProviderError(typed('throttle', 429), 'other')
		expect(classified.status).toBe(429)
		expect(classified.providerId).toBe('test')
	})
})

describe('a classified failure still goes through the retry loop', () => {
	it('retries a typed throttle', async () => {
		// This is the regression: a first-party driver reporting a 429 as
		// `kind: 'throttle'` used to get exactly one attempt, while the same
		// failure from a driver that classified nothing got the full backoff.
		const { provider, calls } = providerThatFails(typed('throttle', 429))
		const wrapped = withProviderRetry(provider, {
			config: { maxRetries: 2 },
			sleepFn: async () => {},
			random: () => 0,
		})

		await expect(async () => {
			for await (const _ of wrapped.chatStream({} as never)) {
				// drain
			}
		}).rejects.toThrow()

		expect(calls()).toBe(3)
	})

	it('does not retry a typed auth failure', async () => {
		const { provider, calls } = providerThatFails(typed('auth', 401))
		const wrapped = withProviderRetry(provider, {
			config: { maxRetries: 2 },
			sleepFn: async () => {},
		})

		await expect(async () => {
			for await (const _ of wrapped.chatStream({} as never)) {
				// drain
			}
		}).rejects.toThrow()

		expect(calls()).toBe(1)
	})

	it('does not retry a typed context overflow', async () => {
		// Correctly non-retryable — an identical prompt overflows identically.
		// The remedy is compaction, which the run loop reaches for once the
		// code is `context_length_exceeded`.
		const { provider, calls } = providerThatFails(typed('context_overflow', 400))
		const wrapped = withProviderRetry(provider, {
			config: { maxRetries: 2 },
			sleepFn: async () => {},
		})

		await expect(async () => {
			for await (const _ of wrapped.chatStream({} as never)) {
				// drain
			}
			// The ORIGINAL escapes, so the boundary still sees the driver's
			// own kind rather than a wrapper's code.
		}).rejects.toMatchObject({ kind: 'context_overflow', status: 400 })

		expect(calls()).toBe(1)
	})

	it('leaves an abort alone', async () => {
		const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
		const { provider, calls } = providerThatFails(abort)
		const wrapped = withProviderRetry(provider, {
			config: { maxRetries: 2 },
			sleepFn: async () => {},
		})

		await expect(async () => {
			for await (const _ of wrapped.chatStream({} as never)) {
				// drain
			}
		}).rejects.toThrow(/aborted/)

		expect(calls()).toBe(1)
	})
})
