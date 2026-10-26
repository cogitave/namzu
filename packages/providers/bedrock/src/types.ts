/**
 * Bedrock-specific provider config shapes.
 *
 * `BedrockConfig` is the constructor input for `BedrockProvider` (no discriminator).
 * `BedrockProviderConfig` is the shape the consumer passes to
 * `ProviderRegistry.create({ type: 'bedrock', ... })` — it extends `BedrockConfig`
 * with the `type: 'bedrock'` discriminator for the registry's generic narrowing.
 */

export interface BedrockConfig {
	region?: string
	accessKeyId?: string
	secretAccessKey?: string
	sessionToken?: string
	timeout?: number
	/**
	 * How long the prompt cache lives: `'5m'` (the default) or `'1h'`. `'1h'` is
	 * sent only for Claude 4.5 and later models; any other model keeps the
	 * default. A call can override it with `cacheControl.ttl`. The longer
	 * lifetime costs more per cache write.
	 */
	promptCacheTtl?: '5m' | '1h'
}

export interface BedrockProviderConfig extends BedrockConfig {
	type: 'bedrock'
}
