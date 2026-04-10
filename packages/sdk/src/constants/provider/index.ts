import type { ProviderCapabilities, ProviderType } from '../../types/provider/index.js'

export const FALLBACK_MOCK_MODEL = 'mock-model'

export const PROVIDER_CAPABILITIES: Record<ProviderType, ProviderCapabilities> = {
	openrouter: {
		supportsTools: true,
		supportsStreaming: true,
		supportsFunctionCalling: true,
	},
	bedrock: {
		supportsTools: true,
		supportsStreaming: true,
		supportsFunctionCalling: true,
	},
	mock: {
		supportsTools: false,
		supportsStreaming: true,
		supportsFunctionCalling: false,
	},
}

export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
