import type { LLMProvider } from './interface.js'

export type ProviderType = 'openrouter' | 'bedrock' | 'mock'

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

export interface MockProviderConfig {
	type: 'mock'
	model?: string
	responseText?: string
	responseDelayMs?: number
}

export type ProviderFactoryConfig =
	| OpenRouterProviderConfig
	| BedrockProviderConfig
	| MockProviderConfig

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
