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
	/** Vendor transport retries. Default 0: let the host own retry/backoff and observe throttles immediately. Set 2 for the previous vendor default. */
	maxRetries?: number
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
	 * Constrained tool-input policy. `auto` enables strict tool use for known
	 * Claude 4.5+ model identifiers, `on` opts a compatible proxy alias in,
	 * and `off` disables it. Default: `auto`.
	 */
	strictToolUse?: 'auto' | 'on' | 'off'
	/**
	 * Bearer-style OAuth access token (mutually exclusive with `apiKey`).
	 * Use when the credential is an Anthropic OAuth or Claude Code OAuth
	 * token rather than an `sk-ant-api-*` console key. The underlying SDK
	 * routes the value as `Authorization: Bearer <token>` instead of
	 * `x-api-key`.
	 */
	authToken?: string
	/**
	 * The `baseURL` is an Anthropic-compatible third-party service, not the
	 * vendor. With it set, an `authToken` is a plain bearer credential: the
	 * subscription beta headers, tool user-agent and identity system block are
	 * not sent, a non-Claude id offers `low`, `high` and `max` effort, and
	 * `listModels` has no offline menu to fall back to. Off by default, so a
	 * token sent through a proxy keeps the identity it always had.
	 */
	compatibleEndpoint?: boolean
	/**
	 * How long the prompt cache lives: `'5m'` (the default, and the service's
	 * own) or `'1h'`. A call can override it with `cacheControl.ttl`. The longer
	 * lifetime costs more per cache write, so it is a cost decision. Every
	 * breakpoint in a request carries the same lifetime.
	 */
	promptCacheTtl?: '5m' | '1h'
	/**
	 * The clock, in epoch milliseconds, used to decide dated vendor deprecations
	 * (fast mode on `claude-opus-4-8` is refused from 2026-11-30). Defaults to
	 * `Date.now`; set it in tests so a date cut-off needs no waiting.
	 */
	clock?: () => number
}

export interface AnthropicProviderConfig extends AnthropicConfig {
	type: 'anthropic'
}
