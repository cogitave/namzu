import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import { toolResultToText } from '@namzu/sdk'
import OpenAI from 'openai'
import type {
	ChatCompletionContentPart,
	ChatCompletionMessageParam,
	ChatCompletionTool,
	ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions'
import type { OpenAIConfig } from './types.js'

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

/**
 * Full capability set — this driver maps tools (`toOpenAITools`), streams
 * natively, and maps user-message image `attachments` into `image_url`
 * content parts with base64 data URIs (`toOpenAIMessages`).
 */
export const OPENAI_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
	supportsDocuments: true,
}

type OpenAIFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call'

type NamzuFinishReason = ChatCompletionResponse['finishReason']

/**
 * Does this model belong to the reasoning family?
 *
 * Matched on the id prefix because that is the only signal available
 * before the first call — there is no capability endpoint to ask, and
 * getting it wrong costs a run rather than a warning.
 *
 * Deliberately conservative: an unknown model falls through to the
 * standard parameters, which is the shape the overwhelming majority of
 * endpoints accept. A false positive would strip `temperature` from a
 * model that honours it, which is a silent behaviour change; a false
 * negative produces a clear 400 naming the parameter.
 */
export function isReasoningModel(model: string): boolean {
	const id = model.toLowerCase()
	// Strip a deployment or vendor prefix such as `openai/gpt-5`.
	const bare = id.slice(id.lastIndexOf('/') + 1)
	return /^(o\d|gpt-5)/.test(bare)
}

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

export function toOpenAIMessages(
	messages: ChatCompletionParams['messages'],
): ChatCompletionMessageParam[] {
	return messages.map((msg): ChatCompletionMessageParam => {
		if (msg.role === 'system') {
			return { role: 'system', content: msg.content }
		}
		if (msg.role === 'user') {
			// User message with attachments → multimodal content parts (text
			// first, then each attachment). Images ride as an `image_url`
			// part carrying a base64 data URI; documents as a `file` part
			// carrying the same URI shape, which is how this wire format
			// takes file input inline. An attachment with no discriminant is
			// an image, which is what every attachment was before documents
			// existed. Plain text-only user messages keep the string form.
			if (msg.attachments && msg.attachments.length > 0) {
				const parts: ChatCompletionContentPart[] = []
				if (msg.content.length > 0) {
					parts.push({ type: 'text', text: msg.content })
				}
				for (const att of msg.attachments) {
					const url = `data:${att.mediaType};base64,${att.data}`
					if (att.type === 'document') {
						parts.push({
							type: 'file',
							file: { file_data: url, ...(att.name ? { filename: att.name } : {}) },
						})
						continue
					}
					parts.push({ type: 'image_url', image_url: { url } })
				}
				return { role: 'user', content: parts }
			}
			return { role: 'user', content: msg.content }
		}
		if (msg.role === 'tool') {
			// Chat Completions tool messages are text-only on the wire, so a
			// non-text block degrades to an honest placeholder rather than
			// having its base64 payload dumped as text.
			return {
				role: 'tool',
				content: toolResultToText(msg.content),
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
	readonly capabilities = OPENAI_CAPABILITIES

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

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		// Whether this stream has produced a tool call yet — see
		// `honestFinishReason`.
		let sawToolCall = false
		const model = this.resolveModel(params)

		const stream = await this.client.chat.completions.create(
			{
				model,
				messages: toOpenAIMessages(params.messages),
				stream: true,
				stream_options: { include_usage: true },
				tools: toOpenAITools(params),
				tool_choice: formatToolChoice(params.toolChoice),
				parallel_tool_calls: params.parallelToolCalls,
				// Reasoning-family models take `max_completion_tokens` and
				// reject `max_tokens` and `temperature` outright. The rejection
				// is a 400, which classifies as `invalid_request` and is
				// therefore not retryable — so sending the wrong pair killed
				// the run on its first turn, every time, for anyone pointing
				// namzu at one of these models with a token cap set (which the
				// runtime always does).
				...(isReasoningModel(model)
					? { max_completion_tokens: params.maxTokens }
					: { temperature: params.temperature, max_tokens: params.maxTokens }),
				top_p: params.topP,
				frequency_penalty: params.frequencyPenalty,
				presence_penalty: params.presencePenalty,
				stop: params.stop,
				response_format: params.responseFormat,
			},
			// Per-request abort: a Stop tears the in-flight SSE request down.
			{ signal: params.signal },
		)

		for await (const chunk of stream) {
			// Stop pulling promptly on abort; `for await` calls the stream's
			// `.return()` on this throw, releasing the connection.
			params.signal?.throwIfAborted()
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
				if (toolCalls && toolCalls.length > 0) sawToolCall = true
				const finishReason = honestFinishReason(
					choice?.finish_reason ? mapFinishReason(choice.finish_reason) : undefined,
					sawToolCall,
				)
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
