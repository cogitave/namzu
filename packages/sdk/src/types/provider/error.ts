/** What went wrong, at the coarsest granularity a caller can act on. */
export type ProviderErrorKind =
	| 'throttle'
	| 'network'
	| 'auth'
	| 'context_overflow'
	| 'bad_request'
	| 'server'

/**
 * Serializable provider-failure metadata carried by failed turns and events.
 *
 * No response body, URL, or `cause` belongs here. `detail` is the one thing
 * the provider itself said, and it arrives scrubbed. `providerCode` preserves
 * a bounded machine identifier independently of wording — see below.
 */
export interface ProviderErrorInfo {
	readonly kind: ProviderErrorKind
	readonly providerId: string
	/** Provider-defined machine code, preserved only when it is a bounded safe token. */
	readonly providerCode?: string
	readonly status?: number
	readonly retryAfterMs?: number
	/**
	 * What the provider said was wrong, truncated and scrubbed of anything
	 * credential-shaped.
	 *
	 * Carried here and not only on the error's `message` for the same reason
	 * `kind` is: a host rendering a failure should not have to parse a
	 * sentence to show one. It is the field that names the offending
	 * parameter, which is usually the whole diagnosis.
	 */
	readonly detail?: string
}

export interface ProviderRequestErrorInit extends ProviderErrorInfo {
	/**
	 * Optional extra clause for the message.
	 *
	 * This used to be required to be text the codebase authored, never a
	 * fragment of a vendor error — and the constructor did not read the field
	 * at all, so nothing carried either kind of text. Providers may now pass
	 * their own complaint through `vendorDetail`, which truncates it and
	 * replaces anything credential-shaped. Text this codebase authored is
	 * still welcome; what is not welcome is a raw body passed straight in.
	 */
	readonly detail?: string
	/**
	 * The provider's own `x-should-retry` verdict, when it sent one. Only `false`
	 * is acted on: a provider that says the same request must not be sent again
	 * is believed over the status code, so the retry loop leaves it alone.
	 */
	readonly shouldRetry?: boolean
	/**
	 * Which part of the network path the request tripped on (a proxy that wants a
	 * sign-in, a certificate nobody trusts), when the vendor error's causes say.
	 * Data and not a `cause`: the raw error is never attached, but the diagnosis
	 * has to survive the wrapping or no one downstream can act on it.
	 */
	readonly transport?: import('./errors.js').TransportCause
}
