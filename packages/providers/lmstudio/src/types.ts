/**
 * LM Studio-specific provider config shapes.
 *
 * `LMStudioConfig` is the constructor input for `LMStudioProvider` (no discriminator).
 * `LMStudioProviderConfig` is the shape the consumer passes to
 * `ProviderRegistry.create({ type: 'lmstudio', ... })` — it extends `LMStudioConfig`
 * with the `type: 'lmstudio'` discriminator for the registry's generic narrowing.
 */

export interface LMStudioConfig {
	/** LM Studio server host. Defaults to http://localhost:1234 or LMSTUDIO_HOST env var. */
	host?: string
	/** Model identifier (must be loaded in LM Studio). */
	model?: string
	timeout?: number
}

export interface LMStudioProviderConfig extends LMStudioConfig {
	type: 'lmstudio'
}
