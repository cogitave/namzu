/**
 * Anthropic-specific provider config shapes.
 *
 * `AnthropicConfig` is the constructor input for `AnthropicProvider`.
 * `AnthropicProviderConfig` is the shape the consumer passes to
 * `ProviderRegistry.create({ type: 'anthropic', ... })` — it extends
 * `AnthropicConfig` with the `type: 'anthropic'` discriminator.
 */

export interface AnthropicConfig {
	apiKey: string
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
}

export interface AnthropicProviderConfig extends AnthropicConfig {
	type: 'anthropic'
}
