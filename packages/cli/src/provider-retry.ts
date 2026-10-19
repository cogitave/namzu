import type { ProviderRetryConfig } from '@namzu/sdk'

/**
 * How the terminal retries a model call that failed for a reason that may pass.
 *
 * Ten retries after the first try, with a wait that starts at half a second and
 * doubles to thirty-two, plus up to a quarter of itself and never less. A wait
 * the provider named is a minimum, not the whole answer: the longer of it and
 * the backoff is slept, and a provider that asks for more than a minute is
 * not waited for (the turn then stops and offers Enter to try again).
 *
 * The SDK's own defaults are shorter (three retries, full jitter) and stay
 * that way for hosts that did not choose this policy.
 */
export const TERMINAL_PROVIDER_RETRY: Partial<ProviderRetryConfig> = {
	maxRetries: 10,
	initialDelayMs: 500,
	maxDelayMs: 32_000,
	maxRetryAfterMs: 60_000,
	jitter: 'proportional',
	retryAfter: 'floor',
}

/**
 * The same policy for a host that can take back what a reply had shown: a
 * stream that dies after some text starts over instead of stopping. A pipe
 * cannot unprint, so only a screen that redraws asks for this.
 */
export function terminalProviderRetry(restartableOutput: boolean): Partial<ProviderRetryConfig> {
	return restartableOutput
		? { ...TERMINAL_PROVIDER_RETRY, retryMidStream: true }
		: TERMINAL_PROVIDER_RETRY
}
