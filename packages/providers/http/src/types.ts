/**
 * HTTP provider config shapes.
 *
 * `HttpConfig` is the constructor input for `HttpProvider` (no discriminator).
 * `HttpProviderConfig` is the shape the consumer passes to
 * `ProviderRegistry.create({ type: 'http', ... })` — it extends `HttpConfig`
 * with the `type: 'http'` discriminator for the registry's generic narrowing.
 */

export type HttpDialect = 'openai' | 'anthropic'

export interface HttpConfig {
	/** Base URL of the endpoint (e.g. https://api.openai.com/v1 or http://localhost:11434/v1). */
	baseURL: string
	/** API key (sent as Authorization: Bearer for openai dialect, x-api-key for anthropic). */
	apiKey?: string
	/** Protocol dialect for request/response shape. Default: 'openai'. */
	dialect?: HttpDialect
	/** Optional extra headers. */
	headers?: Record<string, string>
	/** Default model when chat params don't specify one. */
	model?: string
	/** Request timeout in ms. Default: 60000. */
	timeout?: number
}

export interface HttpProviderConfig extends HttpConfig {
	type: 'http'
}

/**
 * Thrown when the server's response shape does not match the declared `dialect`.
 *
 * Fail-fast by design: silent coercion between OpenAI and Anthropic response
 * shapes would corrupt tool-call arguments and content deltas. The error carries
 * enough information (URL, status, sample body) to diagnose misconfiguration.
 */
export class DialectMismatchError extends Error {
	constructor(
		public readonly dialect: HttpDialect,
		public readonly url: string,
		public readonly status: number,
		public readonly sample: string,
	) {
		super(
			`HttpProvider: response from ${url} (HTTP ${status}) does not match declared dialect '${dialect}'. Check your 'dialect' argument matches the endpoint shape. Known dialects: 'openai' for OpenAI-compat (Ollama, LM Studio, vLLM, Groq, DeepInfra, OpenRouter), 'anthropic' for native Anthropic API. Response sample: ${sample.slice(0, 200)}`,
		)
		this.name = 'DialectMismatchError'
	}
}
