import { randomUUID } from 'node:crypto'
import { LMStudioClient } from '@lmstudio/sdk'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	StreamChunk,
	TokenUsage,
} from '@namzu/sdk'
import type { LMStudioConfig } from './types.js'

type StopReason =
	| 'eosFound'
	| 'userStopped'
	| 'modelUnloaded'
	| 'failed'
	| 'maxPredictedTokensReached'
	| 'contextLengthReached'
	| 'toolCalls'

function mapStopReason(reason: string | undefined): ChatCompletionResponse['finishReason'] {
	switch (reason as StopReason) {
		case 'maxPredictedTokensReached':
		case 'contextLengthReached':
			return 'length'
		case 'toolCalls':
			return 'tool_calls'
		default:
			return 'stop'
	}
}

function mapUsage(stats: {
	promptTokensCount?: number
	predictedTokensCount?: number
	totalTokensCount?: number
}): TokenUsage {
	const promptTokens = stats.promptTokensCount ?? 0
	const completionTokens = stats.predictedTokensCount ?? 0
	return {
		promptTokens,
		completionTokens,
		totalTokens: stats.totalTokensCount ?? promptTokens + completionTokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

type LMStudioRole = 'system' | 'user' | 'assistant'

function toLMStudioChat(
	messages: ChatCompletionParams['messages'],
): Array<{ role: LMStudioRole; content: string }> {
	return messages.map((m) => {
		const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
		const role: LMStudioRole = m.role === 'system' || m.role === 'assistant' ? m.role : 'user'
		// Tool messages aren't first-class in the LMStudio chat API; fold as user content with a marker.
		if (m.role === 'tool') {
			return { role: 'user', content: `[tool-result] ${content}` }
		}
		return { role, content }
	})
}

function normalizeBaseUrl(host: string | undefined): string | undefined {
	if (!host) return undefined
	// LM Studio SDK requires ws:// or wss://. Accept http(s) for ergonomics and convert.
	return host.replace(/^http(s?):\/\//, 'ws$1://')
}

export class LMStudioProvider implements LLMProvider {
	readonly id = 'lmstudio'
	readonly name = 'LM Studio'

	private client: LMStudioClient
	private defaultModel?: string

	constructor(config: LMStudioConfig = {}) {
		const baseUrl = normalizeBaseUrl(config.host ?? process.env.LMSTUDIO_HOST)
		this.client = new LMStudioClient(baseUrl ? { baseUrl } : {})
		this.defaultModel = config.model
	}

	private resolveModel(params: ChatCompletionParams): string {
		const model = params.model || this.defaultModel
		if (!model) {
			throw new Error(
				'LMStudioProvider: model is required. Pass `model` in config or on the chat call.',
			)
		}
		return model
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const modelId = this.resolveModel(params)
		const model = await this.client.llm.model(modelId)
		const prediction = model.respond(toLMStudioChat(params.messages))

		const id = randomUUID()
		for await (const fragment of prediction) {
			if (fragment.content) {
				yield {
					id,
					delta: { content: fragment.content },
				}
			}
		}

		const result = await prediction
		yield {
			id,
			delta: {},
			finishReason: mapStopReason(result.stats.stopReason),
			usage: mapUsage(result.stats),
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		try {
			const loaded = await this.client.llm.listLoaded()
			return loaded.map((m) => {
				const identifier = (m as { identifier?: string; path?: string }).identifier ?? ''
				return {
					id: identifier,
					name: identifier,
					contextWindow: 0,
					maxOutputTokens: 0,
					inputPrice: 0,
					outputPrice: 0,
					supportsToolUse: true,
					supportsStreaming: true,
				}
			})
		} catch {
			return []
		}
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.client.llm.listLoaded()
			return true
		} catch {
			return false
		}
	}
}
