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
}

export interface BedrockProviderConfig extends BedrockConfig {
	type: 'bedrock'
}
