/** What went wrong, at the coarsest granularity a caller can act on. */
export type ProviderErrorKind =
	| 'throttle'
	| 'network'
	| 'auth'
	| 'context_overflow'
	| 'bad_request'
	| 'server'

/**
 * Serializable provider-failure metadata carried by failed runs and events.
 *
 * No response body, vendor message, URL, or `cause` belongs here.
 */
export interface ProviderErrorInfo {
	readonly kind: ProviderErrorKind
	readonly providerId: string
	readonly status?: number
	readonly retryAfterMs?: number
}

export interface ProviderRequestErrorInit extends ProviderErrorInfo {
	/**
	 * Optional extra clause for the message. MUST be text this codebase
	 * authored — never a fragment of a response body, a header, or a vendor
	 * error.
	 */
	readonly detail?: string
}
