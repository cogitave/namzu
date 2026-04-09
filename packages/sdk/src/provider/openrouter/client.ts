import { SpanStatusCode } from '@opentelemetry/api'
import { GENAI, NAMZU, chatSpanName } from '../../telemetry/attributes.js'
import type { TokenUsage } from '../../types/common/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	StreamChunk,
	ToolChoice,
} from '../../types/provider/index.js'
import type { OpenRouterConfig } from '../../types/provider/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { getRootLogger } from '../../utils/logger.js'
import { getTracer } from '../telemetry/setup.js'

const logger = getRootLogger().child({ component: 'OpenRouterProvider' })

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'

interface RawUsage {
	prompt_tokens: number
	completion_tokens: number
	total_tokens: number
	prompt_tokens_details?: {
		cached_tokens?: number
	}
	cache_discount?: number
	cache_read_input_tokens?: number
	cache_creation_input_tokens?: number
}

function parseUsage(raw?: RawUsage): TokenUsage {
	if (!raw) {
		return {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
	}
	return {
		promptTokens: raw.prompt_tokens,
		completionTokens: raw.completion_tokens,
		totalTokens: raw.total_tokens,
		cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? 0,
		cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
	}
}

function parseCacheDiscount(raw?: RawUsage): number {
	return raw?.cache_discount ?? 0
}

function formatToolChoice(tc: ToolChoice): unknown {
	if (typeof tc === 'string') return tc
	return tc
}

export class OpenRouterProvider implements LLMProvider {
	readonly id = 'openrouter'
	readonly name = 'OpenRouter'

	private config: OpenRouterConfig
	private baseUrl: string

	constructor(config: OpenRouterConfig) {
		if (!config.apiKey) {
			throw new Error('OpenRouter API key is required. Set OPENROUTER_API_KEY env variable.')
		}
		this.config = config
		this.baseUrl = config.baseUrl ?? OPENROUTER_BASE_URL
	}

	private getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.config.apiKey}`,
			'Content-Type': 'application/json',
		}
		if (this.config.siteUrl) {
			headers['HTTP-Referer'] = this.config.siteUrl
		}
		if (this.config.siteName) {
			headers['X-Title'] = this.config.siteName
		}
		return headers
	}

	private formatMessages(messages: ChatCompletionParams['messages']): unknown[] {
		return messages.map((msg) => {
			if (msg.role === 'tool') {
				return {
					role: 'tool',
					content: msg.content,
					tool_call_id: (msg as { toolCallId?: string }).toolCallId,
				}
			}
			if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
				return {
					role: 'assistant',
					content: msg.content,
					tool_calls: msg.toolCalls.map((tc) => ({
						id: tc.id,
						type: tc.type,
						function: tc.function,
					})),
				}
			}
			return { role: msg.role, content: msg.content }
		})
	}

	private buildRequestBody(params: ChatCompletionParams, stream: boolean): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model: params.model,
			messages: this.formatMessages(params.messages),
			stream,
		}

		if (params.tools && params.tools.length > 0) {
			body.tools = params.tools
		}
		if (params.toolChoice !== undefined) {
			body.tool_choice = formatToolChoice(params.toolChoice)
		}
		if (params.parallelToolCalls !== undefined) {
			body.parallel_tool_calls = params.parallelToolCalls
		}

		if (params.temperature !== undefined) body.temperature = params.temperature
		if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens
		if (params.topP !== undefined) body.top_p = params.topP
		if (params.topK !== undefined) body.top_k = params.topK
		if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty
		if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty
		if (params.repetitionPenalty !== undefined) body.repetition_penalty = params.repetitionPenalty
		if (params.stop) body.stop = params.stop

		if (params.cacheControl) {
			body.cache_control = params.cacheControl
		}

		if (params.responseFormat) {
			body.response_format = params.responseFormat
		}

		return body
	}

	async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
		const tracer = getTracer()

		return tracer.startActiveSpan(chatSpanName(params.model), async (span) => {
			span.setAttributes({
				[GENAI.OPERATION_NAME]: 'chat',
				[GENAI.SYSTEM]: 'openrouter',
				[GENAI.REQUEST_MODEL]: params.model,
			})
			if (params.temperature !== undefined) {
				span.setAttribute(GENAI.REQUEST_TEMPERATURE, params.temperature)
			}
			if (params.maxTokens !== undefined) {
				span.setAttribute(GENAI.REQUEST_MAX_TOKENS, params.maxTokens)
			}

			try {
				const body = this.buildRequestBody(params, false)

				logger.debug('Sending chat completion request', { model: params.model })

				const response = await fetch(`${this.baseUrl}/chat/completions`, {
					method: 'POST',
					headers: this.getHeaders(),
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(this.config.timeout ?? 120_000),
				})

				if (!response.ok) {
					const errorBody = await response.text()
					logger.error('OpenRouter API error', {
						status: response.status,
						body: errorBody,
					})
					throw new Error(`OpenRouter API error (${response.status}): ${errorBody}`)
				}

				const data = (await response.json()) as {
					id: string
					model: string
					choices: Array<{
						message: {
							role: string
							content: string | null
							tool_calls?: Array<{
								id: string
								type: string
								function: { name: string; arguments: string }
							}>
						}
						finish_reason: string
					}>
					usage?: RawUsage
				}

				const choice = data.choices[0]
				if (!choice) {
					throw new Error('OpenRouter returned empty choices')
				}

				const usage = parseUsage(data.usage)
				const cacheDiscount = parseCacheDiscount(data.usage)

				const result: ChatCompletionResponse = {
					id: data.id,
					model: data.model,
					message: {
						role: 'assistant',
						content: choice.message.content,
						toolCalls: choice.message.tool_calls?.map((tc) => ({
							id: tc.id,
							type: 'function' as const,
							function: tc.function,
						})),
					},
					finishReason: choice.finish_reason as ChatCompletionResponse['finishReason'],
					usage,
				}

				span.setAttributes({
					[GENAI.RESPONSE_ID]: data.id,
					[GENAI.RESPONSE_MODEL]: data.model,
					[GENAI.RESPONSE_FINISH_REASONS]: choice.finish_reason,
					[GENAI.USAGE_INPUT_TOKENS]: usage.promptTokens,
					[GENAI.USAGE_OUTPUT_TOKENS]: usage.completionTokens,
					[NAMZU.CACHE_READ_TOKENS]: usage.cachedTokens,
					[NAMZU.CACHE_WRITE_TOKENS]: usage.cacheWriteTokens,
					[NAMZU.CACHE_DISCOUNT]: cacheDiscount,
				})
				span.setStatus({ code: SpanStatusCode.OK })

				return result
			} catch (err) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: toErrorMessage(err),
				})
				span.recordException(err instanceof Error ? err : new Error(String(err)))
				throw err
			} finally {
				span.end()
			}
		})
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const body = this.buildRequestBody(params, true)

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this.getHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.config.timeout ?? 120_000),
		})

		if (!response.ok) {
			const errorBody = await response.text()
			throw new Error(`OpenRouter API error (${response.status}): ${errorBody}`)
		}

		if (!response.body) {
			throw new Error('OpenRouter returned no stream body')
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split('\n')
				buffer = lines.pop() ?? ''

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || !trimmed.startsWith('data: ')) continue
					const data = trimmed.slice(6)
					if (data === '[DONE]') return

					try {
						const parsed = JSON.parse(data) as {
							id: string
							choices: Array<{
								delta: {
									content?: string
									tool_calls?: Array<{
										index: number
										id?: string
										type?: string
										function?: { name?: string; arguments?: string }
									}>
								}
								finish_reason?: string
							}>
							usage?: RawUsage
						}

						const choice = parsed.choices[0]
						if (!choice) continue

						yield {
							id: parsed.id,
							delta: {
								content: choice.delta.content,
								toolCalls: choice.delta.tool_calls?.map((tc) => ({
									index: tc.index,
									id: tc.id,
									type: tc.type as 'function' | undefined,
									function: tc.function,
								})),
							},
							finishReason: choice.finish_reason as StreamChunk['finishReason'],
							usage: parsed.usage ? parseUsage(parsed.usage) : undefined,
						}
					} catch (parseErr) {
						logger.warn('Failed to parse streaming chunk', {
							error: toErrorMessage(parseErr),
							data: data.slice(0, 200),
						})
						yield {
							id: '',
							delta: { content: undefined },
							finishReason: undefined,
							usage: undefined,
							error: `Stream parse error: ${toErrorMessage(parseErr)}`,
						}
					}
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		const response = await fetch(`${this.baseUrl}/models`, {
			headers: this.getHeaders(),
		})

		if (!response.ok) {
			throw new Error(`Failed to list models: ${response.status}`)
		}

		const data = (await response.json()) as {
			data: Array<{
				id: string
				name: string
				context_length: number
				top_provider?: { max_completion_tokens?: number }
				pricing?: { prompt: string; completion: string }
			}>
		}

		return data.data.map((m) => ({
			id: m.id,
			name: m.name,
			contextWindow: m.context_length,
			maxOutputTokens: m.top_provider?.max_completion_tokens ?? 4096,
			inputPrice: Number.parseFloat(m.pricing?.prompt ?? '0') * 1_000_000,
			outputPrice: Number.parseFloat(m.pricing?.completion ?? '0') * 1_000_000,
			supportsToolUse: true,
			supportsStreaming: true,
		}))
	}

	async healthCheck(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/models`, {
				headers: this.getHeaders(),
				signal: AbortSignal.timeout(5000),
			})
			return response.ok
		} catch {
			return false
		}
	}
}
