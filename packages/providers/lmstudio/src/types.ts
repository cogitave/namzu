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
	/**
	 * Deadline for a completion, in milliseconds. Absent means none, which
	 * is what this has always done regardless of what was set here.
	 *
	 * Composed with the caller cancellation rather than replacing it, and it
	 * covers resolving the model as well as generating: the wait it exists
	 * for is a websocket that connects while the model is still loading into
	 * memory, which happens before a single token is produced.
	 */
	timeout?: number
}

export interface LMStudioProviderConfig extends LMStudioConfig {
	type: 'lmstudio'
}
