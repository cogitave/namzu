import { describe, expect, it } from 'vitest'

import { ProviderError } from '../../types/provider/errors.js'
import type { ChatCompletionParams, StreamChunk } from '../../types/provider/index.js'
import type { LLMProvider } from '../../types/provider/interface.js'
import type { ProviderRetryConfig } from '../retry.js'
import { withProviderRetry } from '../retry.js'

/**
 * One retry config was applied to every member of a chain.
 *
 * An operator running [expensive primary, cheap self-hosted backup] could
 * not give the backup a shorter budget or a different ceiling. The two
 * have different failure shapes and different costs per attempt, and only
 * the driver knows which — the host configuring the chain is choosing
 * between vendors, not tuning each one's transport.
 */

/** Fails every attempt, counting them. */
function failingDriver(retryDefaults?: Partial<ProviderRetryConfig>): LLMProvider & {
	attempts: number
} {
	const driver = {
		id: 'counting',
		name: 'Counting',
		attempts: 0,
		...(retryDefaults ? { retryDefaults } : {}),
		// biome-ignore lint/correctness/useYield: it fails before producing anything
		async *chatStream(_params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			driver.attempts += 1
			// A CLASSIFIED failure. A bare `Error` classifies as
			// non-retryable, so a fixture throwing one measures the
			// classifier rather than the budget — and reports one attempt
			// whatever the config says.
			throw new ProviderError({
				code: 'rate_limit',
				message: 'slow down',
				providerId: 'counting',
				status: 429,
			})
		},
	}
	return driver as unknown as LLMProvider & { attempts: number }
}

async function drain(provider: LLMProvider): Promise<void> {
	try {
		for await (const _chunk of provider.chatStream({} as ChatCompletionParams)) {
			// nothing; the driver always throws
		}
	} catch {
		// expected
	}
}

/** No real waiting: the subject is the attempt COUNT, not the backoff. */
const noSleep = { sleepFn: async () => {}, random: () => 0 }

describe('where a retry budget comes from', () => {
	it("uses the driver's declaration when the caller says nothing", async () => {
		const driver = failingDriver({ maxRetries: 1 })

		await drain(withProviderRetry(driver, noSleep))

		expect(driver.attempts).toBe(2)
	})

	it('lets the caller win, because the caller asked for something specific', async () => {
		// The driver is expressing a default; the host is expressing an
		// intention. Reversing this makes a driver able to override the
		// operator, which is the wrong way round.
		const driver = failingDriver({ maxRetries: 1 })

		await drain(withProviderRetry(driver, { ...noSleep, config: { maxRetries: 5 } }))

		expect(driver.attempts).toBe(6)
	})

	it('merges field by field, so a caller overriding one keeps the rest', async () => {
		// A caller tuning the backoff must not silently discard the driver's
		// retry count. Whole-object replacement passes the two tests above
		// and fails this one.
		const driver = failingDriver({ maxRetries: 3 })

		await drain(withProviderRetry(driver, { ...noSleep, config: { initialDelayMs: 1 } }))

		expect(driver.attempts).toBe(4)
	})

	it('honours a driver that declares no retries at all', async () => {
		// The declaration that most needs honouring: a driver saying its
		// vendor must not be retried. Before the driver layer existed this
		// read the generic default and retried anyway.
		const driver = failingDriver({ maxRetries: 0 })

		await drain(withProviderRetry(driver, noSleep))

		expect(driver.attempts).toBe(1)
	})

	it('returns such a driver UNWRAPPED, not wrapped in a no-op loop', async () => {
		// The observable half of moving the early return below the merge.
		// Above it, that check read only the caller's config, so a driver
		// declaring zero got a wrapper that then retried zero times — the
		// attempt COUNT is identical either way, which is why this asserts
		// identity instead. A wrapper nobody needs is a stack frame and a
		// closure on every call of the hottest path in the runtime.
		const driver = failingDriver({ maxRetries: 0 })

		expect(withProviderRetry(driver, noSleep)).toBe(driver)
	})

	it('falls back to the generic default for a driver that declares nothing', async () => {
		// Absent must stay absent-shaped. A driver from before this existed
		// keeps exactly the behaviour it had.
		const declared = failingDriver()
		const generic = failingDriver()

		await drain(withProviderRetry(declared, noSleep))
		await drain(withProviderRetry(generic, { ...noSleep, config: {} }))

		expect(declared.attempts).toBe(generic.attempts)
		expect(declared.attempts).toBeGreaterThan(1)
	})

	it('is per driver, so two members of a chain retry differently', async () => {
		// The whole point. One config over a whole chain is what made the
		// backup un-tunable.
		const primary = failingDriver({ maxRetries: 3 })
		const backup = failingDriver({ maxRetries: 1 })

		await drain(withProviderRetry(primary, noSleep))
		await drain(withProviderRetry(backup, noSleep))

		expect(primary.attempts).toBe(4)
		expect(backup.attempts).toBe(2)
	})

	it('lets a caller disable retries past a driver that wanted them', async () => {
		// The opt-out has to reach through the declaration, or a driver could
		// re-enable retries a host had switched off.
		const driver = failingDriver({ maxRetries: 5 })

		await drain(withProviderRetry(driver, { ...noSleep, config: { maxRetries: 0 } }))

		expect(driver.attempts).toBe(1)
	})
})
