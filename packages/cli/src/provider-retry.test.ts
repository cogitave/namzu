import { expect, it } from 'vitest'

import { TERMINAL_PROVIDER_RETRY, terminalProviderRetry } from './provider-retry.js'

it('retries ten times, from half a second to thirty-two, with Retry-After as a floor', () => {
	expect(TERMINAL_PROVIDER_RETRY).toEqual({
		maxRetries: 10,
		initialDelayMs: 500,
		maxDelayMs: 32_000,
		maxRetryAfterMs: 60_000,
		jitter: 'proportional',
		retryAfter: 'floor',
	})
})

it('restarts a cut-off stream only for a screen that can take the text back', () => {
	expect(terminalProviderRetry(false).retryMidStream).toBeUndefined()
	expect(terminalProviderRetry(true).retryMidStream).toBe(true)
})
