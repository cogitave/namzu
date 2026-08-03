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
	/**
	 * Anthropic-dialect constrained tool-input policy. `auto` enables strict
	 * tool use for known Claude 4.5+ model identifiers, `on` opts a compatible
	 * proxy alias in, and `off` disables it. Default: `auto`.
	 */
	strictToolUse?: 'auto' | 'on' | 'off'
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
 * shapes would corrupt tool-call arguments and content deltas. Diagnostics keep
 * only the endpoint origin and status; query parameters and response samples are
 * deliberately redacted because both may contain credentials.
 */
export class DialectMismatchError extends Error {
	public readonly url: string
	public readonly sample: string

	constructor(
		public readonly dialect: HttpDialect,
		url: string,
		public readonly status: number,
		_sample: string,
	) {
		const safeUrl = redactDiagnosticUrl(url)
		super(
			`HttpProvider: response from ${safeUrl} (HTTP ${status}) does not match declared dialect '${dialect}'. Check your 'dialect' argument matches the endpoint shape. Known dialects: 'openai' for OpenAI-compat (Ollama, LM Studio, vLLM, Groq, DeepInfra, OpenRouter), 'anthropic' for native Anthropic API. Response body omitted.`,
		)
		this.name = 'DialectMismatchError'
		this.url = safeUrl
		this.sample = '[redacted]'
	}
}

function redactDiagnosticUrl(raw: string): string {
	try {
		return new URL(raw).origin
	} catch {
		return '[redacted endpoint]'
	}
}
