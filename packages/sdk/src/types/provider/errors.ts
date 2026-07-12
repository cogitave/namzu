/**
 * Classification of a provider chat/stream call failure. Providers map their
 * vendor-specific errors (HTTP status, SDK error class, network exception)
 * onto exactly one of these kinds so the runtime loop can make a retry
 * decision without knowing anything about the provider.
 *
 * Retryable kinds are `throttle`, `server`, and `network`. Everything else is
 * terminal for a single logical call: `auth`/`bad_request` are deterministic
 * caller errors, `context_overflow` is handled by reactive compaction rather
 * than a plain retry, `aborted` means the caller cancelled, and `unknown` is
 * treated as non-retryable to avoid hammering an opaque failure.
 */
export type ProviderErrorKind =
	| 'throttle'
	| 'context_overflow'
	| 'auth'
	| 'bad_request'
	| 'server'
	| 'network'
	| 'aborted'
	| 'unknown'

/**
 * Structured detail attached to a {@link ProviderRequestError}. `retryAfterMs`
 * is populated from a `Retry-After` / `x-ratelimit-*` / `anthropic-ratelimit-*`
 * header when the provider adapter has the response in scope; the runtime
 * honors it in place of computed backoff.
 */
export interface ProviderErrorInfo {
	kind: ProviderErrorKind
	/** Upstream HTTP status, when the failure carried one. */
	status?: number
	/** Server-advised wait before the next attempt, in milliseconds. */
	retryAfterMs?: number
	/** Originating provider id (`provider.id`), for diagnostics. */
	providerId?: string
}
