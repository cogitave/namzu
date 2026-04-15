/**
 * Ollama-specific provider config shapes.
 *
 * `OllamaConfig` is the constructor input for `OllamaProvider` (no discriminator).
 * `OllamaProviderConfig` is the shape the consumer passes to
 * `ProviderRegistry.create({ type: 'ollama', ... })` — it extends `OllamaConfig`
 * with the `type: 'ollama'` discriminator for the registry's generic narrowing.
 */

export interface OllamaConfig {
	/** Ollama server host. Defaults to http://localhost:11434 or OLLAMA_HOST env var. */
	host?: string
	/** Optional fetch override (e.g. for custom headers). */
	fetch?: typeof fetch
	/** Default model to use when none specified in chat params. */
	model?: string
	timeout?: number
}

export interface OllamaProviderConfig extends OllamaConfig {
	type: 'ollama'
}
