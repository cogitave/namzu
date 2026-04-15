import type { LLMProvider } from './interface.js'

/**
 * Registry of provider config shapes keyed by provider type string.
 *
 * Third-party provider packages extend this interface via TypeScript module
 * augmentation. Each key in the registry becomes a valid `ProviderType`, and
 * consumers of `ProviderRegistry.create({ type: 'X', ... })` get discriminated
 * union narrowing to the correct config shape.
 *
 * @example
 * ```ts
 * // @namzu/bedrock package
 * declare module '@namzu/sdk' {
 *   interface ProviderConfigRegistry {
 *     bedrock: BedrockProviderConfig
 *   }
 * }
 * ```
 */
export interface ProviderConfigRegistry {
	mock: MockProviderConfig
	// Transitional: bedrock + openrouter still live in sdk core until
	// extracted to their own packages (@namzu/bedrock, @namzu/openrouter).
	// Once extracted, these keys are removed here and re-added via module
	// augmentation in the provider packages.
	bedrock: BedrockProviderConfig
	openrouter: OpenRouterProviderConfig
}

export type ProviderType = keyof ProviderConfigRegistry & string

export type ProviderFactoryConfig = {
	[K in ProviderType]: ProviderConfigRegistry[K]
}[ProviderType]

export interface MockProviderConfig {
	type: 'mock'
	model?: string
	responseText?: string
	responseDelayMs?: number
}

export interface OpenRouterConfig {
	apiKey: string
	baseUrl?: string
	siteUrl?: string
	siteName?: string
	timeout?: number
}

export interface OpenRouterProviderConfig extends OpenRouterConfig {
	type: 'openrouter'
}

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

export interface ProviderCapabilities {
	supportsTools: boolean
	supportsStreaming: boolean
	supportsFunctionCalling: boolean
	maxOutputTokens?: number
}

export interface ProviderFactoryResult {
	provider: LLMProvider
	capabilities: ProviderCapabilities
}

export interface RegisterOptions {
	/** When true, replace an existing registration. Default false → throw on duplicate. */
	replace?: boolean
}

export type LLMProviderConstructor<C = unknown> = new (config: C) => LLMProvider
