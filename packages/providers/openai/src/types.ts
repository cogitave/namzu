/**
 * OpenAI-specific provider config shapes.
 *
 * `OpenAIConfig` is the constructor input for `OpenAIProvider` (no discriminator).
 * `OpenAIProviderConfig` is the shape the consumer passes to
 * `ProviderRegistry.create({ type: 'openai', ... })` — it extends `OpenAIConfig`
 * with the `type: 'openai'` discriminator for the registry's generic narrowing.
 */

export interface OpenAIConfig {
	apiKey: string
	/** Default model. Can be overridden per-call via ChatCompletionParams.model. */
	model?: string
	/** Override the base URL (e.g. for Azure OpenAI or Enterprise endpoints). */
	baseURL?: string
	/** Organization ID. */
	organization?: string
	/** Project ID. */
	project?: string
	/** Request timeout in ms. */
	timeout?: number
	/** Custom headers appended to every request. */
	defaultHeaders?: Record<string, string>
}

export interface OpenAIProviderConfig extends OpenAIConfig {
	type: 'openai'
}
