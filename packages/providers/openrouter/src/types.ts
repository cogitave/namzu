/**
 * OpenRouter-specific provider config shapes.
 *
 * `OpenRouterConfig` is the constructor input for `OpenRouterProvider` (no
 * discriminator). `OpenRouterProviderConfig` is the shape the consumer passes
 * to `ProviderRegistry.create({ type: 'openrouter', ... })` — it extends
 * `OpenRouterConfig` with the `type: 'openrouter'` discriminator for the
 * registry's generic narrowing.
 */

export interface OpenRouterConfig {
	apiKey: string
	baseUrl?: string
	siteUrl?: string
	siteName?: string
	timeout?: number
	/** Receives the driver's debug lines. Absent, they are discarded. */
	logger?: import('@namzu/sdk').Logger
}

export interface OpenRouterProviderConfig extends OpenRouterConfig {
	type: 'openrouter'
}
