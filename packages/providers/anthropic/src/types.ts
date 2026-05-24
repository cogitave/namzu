/**
 * Anthropic-specific provider config shapes.
 *
 * `AnthropicConfig` is the constructor input for `AnthropicProvider`.
 * `AnthropicProviderConfig` is the shape the consumer passes to
 * `ProviderRegistry.create({ type: 'anthropic', ... })` — it extends
 * `AnthropicConfig` with the `type: 'anthropic'` discriminator.
 */

export interface AnthropicConfig {
	/**
	 * Console API key (`sk-ant-api-*`). Mutually exclusive with `authToken`.
	 * Exactly one of `apiKey` / `authToken` must be set.
	 */
	apiKey?: string
	/** Default model. Can be overridden per-call. */
	model?: string
	/** Override base URL (e.g. for AWS Bedrock Anthropic or Google Vertex endpoints — though use @namzu/bedrock for those). */
	baseURL?: string
	/** Request timeout in ms. */
	timeout?: number
	/**
	 * Optional per-event stream idle watchdog in ms. Disabled by default.
	 * Use only for deployments that need to fail a stalled SSE connection
	 * independently from the request timeout.
	 */
	streamIdleTimeoutMs?: number
	/** Custom headers appended to every request. */
	defaultHeaders?: Record<string, string>
	/** Default max_tokens (Anthropic requires this field). Default: 64000. */
	maxTokens?: number
	/**
	 * Bearer-style OAuth access token (mutually exclusive with `apiKey`).
	 * Use when the credential is an Anthropic OAuth or Claude Code OAuth
	 * token rather than an `sk-ant-api-*` console key. The underlying SDK
	 * routes the value as `Authorization: Bearer <token>` instead of
	 * `x-api-key`.
	 */
	authToken?: string
}

export interface AnthropicProviderConfig extends AnthropicConfig {
	type: 'anthropic'
}
