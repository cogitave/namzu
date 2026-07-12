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

export interface ProviderCapabilities {
	supportsTools: boolean
	supportsStreaming: boolean
	supportsFunctionCalling: boolean
	maxOutputTokens?: number
	/**
	 * Whether the provider forwards `ChatCompletionParams.signal` to its
	 * transport so an in-flight request is actually aborted. Absent/false means
	 * cancellation only takes effect at the next iteration boundary (e.g.
	 * Ollama's non-streaming path). See ses_015 A6 / Phase B.
	 */
	supportsAbortSignal?: boolean
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
