import { randomUUID } from 'node:crypto'
import type {
	ChatCompletionParams,
	LLMProvider,
	ModelInfo,
	StreamChunk,
	TokenUsage,
} from '@namzu/sdk'
import { type ChatResponse, Ollama, type Message as OllamaMessage } from 'ollama'
import type { OllamaConfig } from './types.js'

const DEFAULT_HOST = 'http://localhost:11434'

function resolveHost(config: OllamaConfig): string {
	if (config.host) return config.host
	const envHost = process.env.OLLAMA_HOST
	if (envHost && envHost.length > 0) return envHost
	return DEFAULT_HOST
}

function toOllamaMessages(messages: ChatCompletionParams['messages']): OllamaMessage[] {
	return messages.map((msg) => ({
		role: msg.role,
		content: typeof msg.content === 'string' ? msg.content : (msg.content ?? ''),
	}))
}

function buildUsage(resp: Pick<ChatResponse, 'prompt_eval_count' | 'eval_count'>): TokenUsage {
	const promptTokens = resp.prompt_eval_count ?? 0
	const completionTokens = resp.eval_count ?? 0
	return {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

export class OllamaProvider implements LLMProvider {
	readonly id = 'ollama'
	readonly name = 'Ollama'

	private client: Ollama
	private config: OllamaConfig

	constructor(config: OllamaConfig = {}) {
		this.config = config
		this.client = new Ollama({
			host: resolveHost(config),
			...(config.fetch ? { fetch: config.fetch } : {}),
		})
	}

	private buildOptions(params: ChatCompletionParams): Record<string, number | string[]> {
		const options: Record<string, number | string[]> = {}
		if (params.temperature !== undefined) options.temperature = params.temperature
		if (params.topP !== undefined) options.top_p = params.topP
		if (params.topK !== undefined) options.top_k = params.topK
		if (params.maxTokens !== undefined) options.num_predict = params.maxTokens
		if (params.stop) options.stop = params.stop
		return options
	}

	private resolveModel(params: ChatCompletionParams): string {
		const model = params.model || this.config.model
		if (!model) {
			throw new Error(
				'OllamaProvider: no model specified. Pass `model` on the chat params or set a default via config.',
			)
		}
		return model
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const model = this.resolveModel(params)
		const messages = toOllamaMessages(params.messages)
		const options = this.buildOptions(params)

		const stream = await this.client.chat({
			model,
			messages,
			stream: true,
			...(Object.keys(options).length > 0 ? { options } : {}),
		})

		const id = randomUUID()

		for await (const chunk of stream) {
			const content = chunk.message?.content
			if (content && content.length > 0) {
				yield {
					id,
					delta: { content },
				}
			}

			if (chunk.done === true) {
				const usage = buildUsage(chunk)
				yield {
					id,
					delta: {},
					finishReason: 'stop',
					usage,
				}
			}
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		const resp = await this.client.list()
		return resp.models.map((m) => ({
			id: m.name,
			name: m.name,
			contextWindow: 0,
			maxOutputTokens: 0,
			inputPrice: 0,
			outputPrice: 0,
			supportsToolUse: false,
			supportsStreaming: true,
		}))
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.client.list()
			return true
		} catch {
			return false
		}
	}
}
