import type {
	ChatCompletionParams,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import { toolResultToText } from '@namzu/sdk'
import type { OpenRouterConfig } from './types.js'

/**
 * Report a turn that produced tool calls as `tool_calls`, whatever the
 * endpoint called it.
 *
 * Endpoints on this wire shape — gateways and local servers especially —
 * routinely send `finish_reason: "stop"` on the same response that carries
 * a populated `tool_calls`. Passing that through says the turn is over
 * when the model has just asked for work, and a consumer that trusts the
 * reason skips every call it was handed.
 *
 * The calls are the fact and the reason is the summary, so when they
 * disagree the calls win. The tool call can also arrive in the same chunk
 * as the reason, so the current chunk is checked as well as the ones
 * before it.
 */
function honestFinishReason(
	reported: StreamChunk['finishReason'],
	sawToolCall: boolean,
): StreamChunk['finishReason'] {
	if (reported === undefined) return undefined
	return sawToolCall && reported === 'stop' ? 'tool_calls' : reported
}

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

function formatToolChoice(tc: ToolChoice): unknown {
	if (typeof tc === 'string') return tc
	return tc
}

/**
 * Image media types the vision path carries. Anything else is named in
 * the text rather than sent: an endpoint that cannot decode the payload
 * would reject the whole request, and losing the turn is worse than
 * losing sight of one image.
 */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
	'image/png',
	'image/jpeg',
	'image/jpg',
	'image/webp',
	'image/gif',
])

function unsupportedImageNote(mediaType: string, kind: 'image' | 'document' = 'image'): string {
	return `[${kind}: ${mediaType} — unsupported format, not sent]`
}

/**
 * What this DRIVER does, not what the gateway could do: tools pass
 * through to the request body, and a user-message image becomes a
 * content part carrying a `data:` URI. A format the wire does not accept
 * is named in the text instead of being sent.
 *
 * An image inside a TOOL RESULT stays a text placeholder — a tool message
 * is text-only here, so there is nowhere to put it.
 */
export const OPENROUTER_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
	// Images only. A document degrades to a named note, and the runtime
	// warns before the request rather than after the model answered
	// about a file it never saw.
	supportsDocuments: false,
}

export class OpenRouterProvider implements LLMProvider {
	readonly id = 'openrouter'
	readonly name = 'OpenRouter'
	readonly capabilities = OPENROUTER_CAPABILITIES

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
					// Tool messages are text-only on this wire, so a content
					// block array has to be flattened. Passing it through raw
					// sent a malformed body; the helper degrades a non-text
					// block to an honest placeholder naming its type and size
					// instead of dumping base64 the model cannot decode.
					content: toolResultToText(msg.content),
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
			if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
				const parts: unknown[] = []
				const notes: string[] = []
				for (const attachment of msg.attachments) {
					if (IMAGE_MEDIA_TYPES.has(attachment.mediaType.toLowerCase())) {
						parts.push({
							type: 'image_url',
							image_url: { url: `data:${attachment.mediaType};base64,${attachment.data}` },
						})
					} else {
						notes.push(unsupportedImageNote(attachment.mediaType, attachment.type ?? 'image'))
					}
				}
				const head = [msg.content, ...notes].filter((part) => part.length > 0).join('\n')
				return {
					role: 'user',
					content: [...(head.length > 0 ? [{ type: 'text', text: head }] : []), ...parts],
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

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		// Whether this stream has produced a tool call yet — see
		// `honestFinishReason`.
		let sawToolCall = false
		const body = this.buildRequestBody(params, true)

		const timeout = AbortSignal.timeout(this.config.timeout ?? 120_000)
		// Compose the caller abort with the request timeout so a Stop cancels the
		// response body stream. When no caller signal is present this is the exact
		// prior `AbortSignal.timeout(...)` expression (byte-identical).
		const signal = params.signal ? AbortSignal.any([timeout, params.signal]) : timeout

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this.getHeaders(),
			body: JSON.stringify(body),
			signal,
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
				params.signal?.throwIfAborted()
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

						if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
							sawToolCall = true
						}
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
							finishReason: honestFinishReason(
								choice.finish_reason as StreamChunk['finishReason'],
								sawToolCall,
							),
							usage: parsed.usage ? parseUsage(parsed.usage) : undefined,
						}
					} catch (parseErr) {
						yield {
							id: '',
							delta: { content: undefined },
							finishReason: undefined,
							usage: undefined,
							error: `Stream parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
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
