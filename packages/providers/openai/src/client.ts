import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	StreamChunk,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import OpenAI from 'openai'
import type {
	ChatCompletionMessageParam,
	ChatCompletionTool,
	ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions'
import type { OpenAIConfig } from './types.js'

type OpenAIFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call'

type NamzuFinishReason = ChatCompletionResponse['finishReason']

function mapFinishReason(reason: OpenAIFinishReason | null | undefined): NamzuFinishReason {
	switch (reason) {
		case 'length':
			return 'length'
		case 'tool_calls':
		case 'function_call':
			return 'tool_calls'
		case 'content_filter':
			return 'content_filter'
		default:
			return 'stop'
	}
}

interface RawOpenAIUsage {
	prompt_tokens?: number
	completion_tokens?: number
	total_tokens?: number
	prompt_tokens_details?: { cached_tokens?: number }
}

function parseUsage(raw?: RawOpenAIUsage | null): TokenUsage {
	if (!raw) {
		return {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
	}
	const promptTokens = raw.prompt_tokens ?? 0
	const completionTokens = raw.completion_tokens ?? 0
	return {
		promptTokens,
		completionTokens,
		totalTokens: raw.total_tokens ?? promptTokens + completionTokens,
		cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
		cacheWriteTokens: 0,
	}
}

function formatToolChoice(tc: ToolChoice | undefined): ChatCompletionToolChoiceOption | undefined {
	if (tc === undefined) return undefined
	if (tc === 'auto' || tc === 'none' || tc === 'required') return tc
	if (typeof tc === 'object' && tc.type === 'function') {
		return { type: 'function', function: { name: tc.function.name } }
	}
	return undefined
}

function toOpenAIMessages(
	messages: ChatCompletionParams['messages'],
): ChatCompletionMessageParam[] {
	return messages.map((msg): ChatCompletionMessageParam => {
		if (msg.role === 'system') {
			return { role: 'system', content: msg.content }
		}
		if (msg.role === 'user') {
			return { role: 'user', content: msg.content }
		}
		if (msg.role === 'tool') {
			return {
				role: 'tool',
				content: msg.content,
				tool_call_id: msg.toolCallId,
			}
		}
		// assistant
		const assistant: ChatCompletionMessageParam = {
			role: 'assistant',
			content: msg.content,
		}
		if ('toolCalls' in msg && msg.toolCalls && msg.toolCalls.length > 0) {
			;(assistant as { tool_calls?: unknown }).tool_calls = msg.toolCalls.map((tc) => ({
				id: tc.id,
				type: 'function' as const,
				function: {
					name: tc.function.name,
					arguments: tc.function.arguments,
				},
			}))
		}
		return assistant
	})
}

function toOpenAITools(params: ChatCompletionParams): ChatCompletionTool[] | undefined {
	if (!params.tools || params.tools.length === 0) return undefined
	return params.tools.map((t) => ({
		type: 'function' as const,
		function: {
			name: t.function.name,
			description: t.function.description ?? '',
			parameters: (t.function.parameters ?? {}) as Record<string, unknown>,
		},
	}))
}

export class OpenAIProvider implements LLMProvider {
	readonly id = 'openai'
	readonly name = 'OpenAI'

	private client: OpenAI
	private defaultModel?: string

	constructor(config: OpenAIConfig) {
		if (!config.apiKey) {
			throw new Error('OpenAI API key is required. Set OPENAI_API_KEY env variable.')
		}

		const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
			apiKey: config.apiKey,
		}
		if (config.baseURL) clientOptions.baseURL = config.baseURL
		if (config.organization) clientOptions.organization = config.organization
		if (config.project) clientOptions.project = config.project
		if (config.timeout !== undefined) clientOptions.timeout = config.timeout
		if (config.defaultHeaders) clientOptions.defaultHeaders = config.defaultHeaders

		this.client = new OpenAI(clientOptions)
		this.defaultModel = config.model
	}

	private resolveModel(params: ChatCompletionParams): string {
		const model = params.model || this.defaultModel
		if (!model) {
			throw new Error(
				'OpenAIProvider: model is required. Pass `model` in config or on the chat call.',
			)
		}
		return model
	}

	async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
		const model = this.resolveModel(params)

		const response = await this.client.chat.completions.create({
			model,
			messages: toOpenAIMessages(params.messages),
			stream: false,
			tools: toOpenAITools(params),
			tool_choice: formatToolChoice(params.toolChoice),
			parallel_tool_calls: params.parallelToolCalls,
			temperature: params.temperature,
			max_tokens: params.maxTokens,
			top_p: params.topP,
			frequency_penalty: params.frequencyPenalty,
			presence_penalty: params.presencePenalty,
			stop: params.stop,
			response_format: params.responseFormat,
		})

		const choice = response.choices[0]
		if (!choice) {
			throw new Error('OpenAI returned empty choices')
		}

		const toolCalls = choice.message.tool_calls
			?.filter((tc): tc is Extract<typeof tc, { type: 'function' }> => tc.type === 'function')
			.map((tc) => ({
				id: tc.id,
				type: 'function' as const,
				function: {
					name: tc.function.name,
					arguments: tc.function.arguments,
				},
			}))

		return {
			id: response.id,
			model: response.model,
			message: {
				role: 'assistant',
				content: choice.message.content,
				toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
			},
			finishReason: mapFinishReason(choice.finish_reason),
			usage: parseUsage(response.usage),
		}
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const model = this.resolveModel(params)

		const stream = await this.client.chat.completions.create({
			model,
			messages: toOpenAIMessages(params.messages),
			stream: true,
			stream_options: { include_usage: true },
			tools: toOpenAITools(params),
			tool_choice: formatToolChoice(params.toolChoice),
			parallel_tool_calls: params.parallelToolCalls,
			temperature: params.temperature,
			max_tokens: params.maxTokens,
			top_p: params.topP,
			frequency_penalty: params.frequencyPenalty,
			presence_penalty: params.presencePenalty,
			stop: params.stop,
			response_format: params.responseFormat,
		})

		for await (const chunk of stream) {
			try {
				const choice = chunk.choices[0]
				const delta = choice?.delta

				const toolCalls = delta?.tool_calls?.map((tc) => ({
					index: tc.index,
					id: tc.id,
					type: tc.type,
					function: tc.function
						? {
								name: tc.function.name,
								arguments: tc.function.arguments,
							}
						: undefined,
				}))

				const hasDelta =
					(delta?.content !== undefined && delta.content !== null) ||
					(toolCalls && toolCalls.length > 0)
				const finishReason = choice?.finish_reason
					? mapFinishReason(choice.finish_reason)
					: undefined
				const usage = chunk.usage ? parseUsage(chunk.usage) : undefined

				if (!hasDelta && !finishReason && !usage) continue

				yield {
					id: chunk.id,
					delta: {
						content: delta?.content ?? undefined,
						toolCalls,
					},
					finishReason,
					usage,
				}
			} catch (parseErr) {
				yield {
					id: chunk.id ?? '',
					delta: {},
					error: `Stream parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
				}
			}
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		const page = await this.client.models.list()
		return page.data.map((m) => ({
			id: m.id,
			name: m.id,
			contextWindow: 0,
			maxOutputTokens: 0,
			inputPrice: 0,
			outputPrice: 0,
			supportsToolUse: true,
			supportsStreaming: true,
		}))
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.client.models.list()
			return true
		} catch {
			return false
		}
	}
}
