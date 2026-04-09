import type { TokenUsage } from '../types/common/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	MockProviderConfig,
	ProviderCapabilities,
	ProviderFactoryConfig,
	ProviderFactoryResult,
	ProviderType,
	StreamChunk,
} from '../types/provider/index.js'
import { BedrockProvider } from './bedrock/client.js'
import { OpenRouterProvider } from './openrouter/client.js'

const FALLBACK_MOCK_MODEL = 'mock-model'

class MockLLMProvider implements LLMProvider {
	readonly id = 'mock'
	readonly name = 'Mock LLM Provider'

	private readonly model: string
	private readonly responseText: string
	private readonly responseDelayMs: number

	constructor(config: MockProviderConfig) {
		this.model = config.model ?? FALLBACK_MOCK_MODEL
		this.responseText = config.responseText ?? 'Mock provider response'
		this.responseDelayMs = config.responseDelayMs ?? 0
	}

	private buildUsage(): TokenUsage {
		return {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
	}

	private async delay(): Promise<void> {
		if (this.responseDelayMs <= 0) return
		await new Promise((resolve) => setTimeout(resolve, this.responseDelayMs))
	}

	private normalizeResponse(params: ChatCompletionParams, message: string): ChatCompletionResponse {
		return {
			id: `mock-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
			model: params.model ?? this.model,
			message: {
				role: 'assistant',
				content: message,
			},
			finishReason: 'stop',
			usage: this.buildUsage(),
		}
	}

	async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
		await this.delay()
		return this.normalizeResponse(params, this.responseText)
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const response = await this.chat(params)
		const content = response.message.content ?? ''
		const chunkSize = 8

		for (let i = 0; i < content.length; i += chunkSize) {
			yield {
				id: response.id,
				delta: {
					content: content.slice(i, i + chunkSize),
				},
			}
		}

		yield {
			id: response.id,
			delta: {},
			finishReason: 'stop',
			usage: response.usage,
		}
	}

	async listModels() {
		return [
			{
				id: this.model,
				name: 'Mock Model',
				contextWindow: 32_000,
				maxOutputTokens: 8_000,
				inputPrice: 0,
				outputPrice: 0,
				supportsToolUse: false,
				supportsStreaming: true,
			},
		]
	}

	async healthCheck() {
		await this.delay()
		return true
	}
}

const PROVIDER_CAPABILITIES: Record<ProviderType, ProviderCapabilities> = {
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

export class UnknownProviderError extends Error {
	readonly providerType: string

	constructor(providerType: string) {
		super(`Unsupported provider type: ${providerType}`)
		this.name = 'UnknownProviderError'
		this.providerType = providerType
	}
}

export class ProviderFactory {
	static create(config: ProviderFactoryConfig): ProviderFactoryResult {
		const provider = ProviderFactory.createProvider(config)
		const capabilities = ProviderFactory.getCapabilities(config.type)
		return { provider, capabilities }
	}

	static createProvider(config: ProviderFactoryConfig): LLMProvider {
		if (config.type === 'openrouter') {
			const { type, ...openrouterConfig } = config
			return new OpenRouterProvider(openrouterConfig)
		}
		if (config.type === 'bedrock') {
			const { type, ...bedrockConfig } = config
			return new BedrockProvider(bedrockConfig)
		}
		if (config.type === 'mock') {
			return new MockLLMProvider(config)
		}

		throw new UnknownProviderError((config as { type: string }).type)
	}

	static getCapabilities(type: ProviderType): ProviderCapabilities {
		const capabilities = PROVIDER_CAPABILITIES[type]
		if (!capabilities) {
			throw new UnknownProviderError(type)
		}

		return capabilities
	}

	static isSupported(type: string): type is ProviderType {
		return type === 'openrouter' || type === 'bedrock' || type === 'mock'
	}
}

export { OpenRouterProvider, BedrockProvider, MockLLMProvider }
