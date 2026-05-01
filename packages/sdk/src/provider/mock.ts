import { FALLBACK_MOCK_MODEL } from '../constants/provider/index.js'
import type { TokenUsage } from '../types/common/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	MockProviderConfig,
	StreamChunk,
} from '../types/provider/index.js'

export class MockLLMProvider implements LLMProvider {
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

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		await this.delay()
		const response = this.normalizeResponse(params, this.responseText)
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
