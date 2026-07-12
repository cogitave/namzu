import type { ProviderErrorInfo, ProviderErrorKind } from '../types/provider/errors.js'

/**
 * Options accepted by {@link ProviderRequestError}. Extends
 * {@link ProviderErrorInfo} with an optional `cause` so an adapter can retain
 * the original vendor error for debugging while presenting a uniform,
 * runtime-classifiable shape.
 */
export interface ProviderRequestErrorOptions extends ProviderErrorInfo {
	cause?: unknown
}

/**
 * Uniform error thrown by provider adapters when a chat/stream call fails.
 * The runtime loop classifies retries purely off {@link ProviderRequestError.kind}
 * (see {@link ProviderErrorKind}) — no provider-specific `instanceof` checks
 * leak into `@namzu/sdk`. Style mirrors `@namzu/http`'s `DialectMismatchError`:
 * readonly property fields carrying the structured detail, `.name` overridden.
 */
export class ProviderRequestError extends Error {
	readonly kind: ProviderErrorKind
	readonly status?: number
	readonly retryAfterMs?: number
	readonly providerId?: string

	constructor(message: string, options: ProviderRequestErrorOptions) {
		super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
		this.name = 'ProviderRequestError'
		this.kind = options.kind
		this.status = options.status
		this.retryAfterMs = options.retryAfterMs
		this.providerId = options.providerId
	}
}

/** Type guard for {@link ProviderRequestError}. */
export function isProviderRequestError(err: unknown): err is ProviderRequestError {
	return err instanceof ProviderRequestError
}

/**
 * Map an HTTP status code onto a {@link ProviderErrorKind}. Shared by every
 * fetch/SDK-based adapter so status classification is consistent across
 * providers. Note: context-overflow is NOT derivable from status alone
 * (it usually arrives as a 400 with a body-level code), so adapters detect it
 * separately and pass `kind: 'context_overflow'` explicitly — this helper
 * classifies a bare 400 as `bad_request`.
 */
export function classifyHttpStatus(status: number): ProviderErrorKind {
	if (status === 429) return 'throttle'
	if (status === 401 || status === 403) return 'auth'
	if (status === 400 || status === 404 || status === 422) return 'bad_request'
	if (status >= 500) return 'server'
	if (status >= 400) return 'bad_request'
	return 'unknown'
}
