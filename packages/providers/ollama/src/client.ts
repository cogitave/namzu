import { randomUUID } from 'node:crypto'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	StreamChunk,
	TokenUsage,
} from '@namzu/sdk'
import {
	type AbortableAsyncIterator,
	type ChatResponse,
	Ollama,
	type Message as OllamaMessage,
} from 'ollama'
import { abortedError, toOllamaProviderError } from './errors.js'
import type { OllamaConfig } from './types.js'

const DEFAULT_HOST = 'http://localhost:11434'

/**
 * Map Ollama's `done_reason` onto the SDK `finishReason`. The client previously
 * hardcoded `'stop'` and discarded `done_reason`, so a length-truncated response
 * was indistinguishable from a natural completion. Ollama emits no dedicated
 * tool-call reason (and this provider does not surface tools), and it also uses
 * `'load'`/`'unload'` for model-lifecycle responses — none of which map to a
 * distinct SDK reason, so anything other than `'length'` resolves to `'stop'`.
 */
function mapDoneReason(doneReason: string | undefined): ChatCompletionResponse['finishReason'] {
	return doneReason === 'length' ? 'length' : 'stop'
}

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

	async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
		const model = this.resolveModel(params)
		// The vendor SDK's non-streaming chat() exposes no signal path, so an
		// in-flight call cannot be aborted (supportsAbortSignal: false). Honor the
		// signal at the call boundary at least, so a pre-aborted run does not fire a
		// request that can no longer be cancelled.
		if (params.signal?.aborted) {
			throw abortedError('OllamaProvider: request aborted before dispatch')
		}
		const messages = toOllamaMessages(params.messages)
		const options = this.buildOptions(params)

		let resp: ChatResponse
		try {
			resp = await this.client.chat({
				model,
				messages,
				stream: false,
				...(Object.keys(options).length > 0 ? { options } : {}),
			})
		} catch (err) {
			throw toOllamaProviderError(err, params.signal)
		}

		const id = randomUUID()
		const usage = buildUsage(resp)

		return {
			id,
			model: resp.model,
			message: {
				role: 'assistant',
				content: resp.message.content ?? null,
			},
			finishReason: mapDoneReason(resp.done_reason),
			usage,
		}
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const model = this.resolveModel(params)
		if (params.signal?.aborted) {
			throw abortedError('OllamaProvider: request aborted before dispatch')
		}
		const messages = toOllamaMessages(params.messages)
		const options = this.buildOptions(params)

		let stream: AbortableAsyncIterator<ChatResponse>
		try {
			stream = await this.client.chat({
				model,
				messages,
				stream: true,
				...(Object.keys(options).length > 0 ? { options } : {}),
			})
		} catch (err) {
			throw toOllamaProviderError(err, params.signal)
		}

		// Unlike non-streaming chat(), the vendor streaming iterator exposes
		// .abort(); forward params.signal to it best-effort. supportsAbortSignal
		// stays false because the primary chat() path remains non-abortable.
		const signal = params.signal
		const onAbort = () => stream.abort()
		if (signal) {
			if (signal.aborted) stream.abort()
			else signal.addEventListener('abort', onAbort, { once: true })
		}

		const id = randomUUID()

		try {
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
						finishReason: mapDoneReason(chunk.done_reason),
						usage,
					}
				}
			}
		} catch (err) {
			throw toOllamaProviderError(err, signal)
		} finally {
			if (signal) signal.removeEventListener('abort', onAbort)
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
