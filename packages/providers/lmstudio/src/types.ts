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
	/**
	 * An already-connected backend client to use instead of dialing a new
	 * one.
	 *
	 * The underlying SDK opens its websocket in the constructor, so a host
	 * running several providers against the same server would otherwise
	 * open a connection per provider and have no handle on their lifetime.
	 * Passing one in makes the connection the host's to own.
	 */
	client?: import('./client.js').BackendClient
}

export interface LMStudioProviderConfig extends LMStudioConfig {
	type: 'lmstudio'
}
