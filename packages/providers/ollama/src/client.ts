import { randomUUID } from 'node:crypto'
import type {
	ChatCompletionParams,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	TokenUsage,
} from '@namzu/sdk'
import { toolResultToText } from '@namzu/sdk'
import {
	type ChatResponse,
	Ollama,
	type Message as WireMessage,
	type Tool as WireTool,
	type ToolCall as WireToolCall,
} from 'ollama'
import type { OllamaConfig } from './types.js'

/**
 * What this DRIVER does, not what the server could do.
 *
 * The driver now maps tool schemas onto the request, reassembles tool
 * calls off the stream, echoes an assistant turn's own calls back with
 * the call arguments intact, and carries user-message image attachments
 * as image bytes rather than as a text placeholder.
 *
 * Images inside a *tool result* are carried too, and additionally keep a
 * short text marker naming the block — the wire has one images channel
 * per message and no way to bind an image to a position in the result,
 * so the marker is what tells the model which result the image belongs
 * to. Documents have no image channel and stay as a text placeholder.
 *
 * Flip these only alongside the corresponding mapping code.
 */
export const OLLAMA_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
	// Images only. A document degrades to a named note, and the runtime
	// warns before the request rather than after the model answered
	// about a file it never saw.
	supportsDocuments: false,
}

const DEFAULT_HOST = 'http://localhost:11434'

function resolveHost(config: OllamaConfig): string {
	if (config.host) return config.host
	const envHost = process.env.OLLAMA_HOST
	if (envHost && envHost.length > 0) return envHost
	return DEFAULT_HOST
}

/**
 * Image media types the vision path accepts.
 *
 * The wire takes raw base64 with no media type beside it, so the server
 * sniffs the bytes. Anything it cannot decode fails the whole request —
 * one unsupported attachment would take the turn down with it — so an
 * unrecognised type stays a text placeholder and the run continues.
 */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
	'image/png',
	'image/jpeg',
	'image/jpg',
	'image/webp',
	'image/gif',
])

function isCarriableImage(mediaType: string): boolean {
	return IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase())
}

/**
 * Split tool-result content into the text the model reads and the images
 * it can actually see.
 *
 * `toolResultToText` alone renders an image as `[image: … not renderable
 * by this provider]`, which was true of this driver and is no longer. The
 * marker it leaves behind is kept deliberately: see the note on
 * {@link OLLAMA_CAPABILITIES}.
 */
function splitToolResult(content: ChatCompletionParams['messages'][number]['content']): {
	text: string
	images: string[]
} {
	if (typeof content !== 'string' && content !== null) {
		const images: string[] = []
		const parts: string[] = []
		for (const block of content) {
			if (block.type === 'image' && isCarriableImage(block.mediaType)) {
				images.push(block.data)
				parts.push(`[image: ${block.mediaType}]`)
				continue
			}
			parts.push(toolResultToText([block]))
		}
		return { text: parts.join('\n'), images }
	}
	return { text: content === null ? '' : content, images: [] }
}

/**
 * The wire carries a tool result by tool NAME, not by call id, so a result
 * cannot be mapped without knowing which call produced it. The names live
 * on the preceding assistant turn; this indexes them by call id first so
 * the mapping is a lookup rather than a backward scan per result.
 */
function indexToolNames(messages: ChatCompletionParams['messages']): Map<string, string> {
	const names = new Map<string, string>()
	for (const msg of messages) {
		if (msg.role !== 'assistant' || !msg.toolCalls) continue
		for (const call of msg.toolCalls) {
			names.set(call.id, call.function.name)
		}
	}
	return names
}

/**
 * Arguments travel as a string through the runtime and as an object on
 * this wire.
 *
 * A parse failure means the model emitted malformed JSON, which the
 * runtime already records on the call. Echoing `{}` keeps the turn
 * replayable and keeps the call visible to the model — dropping the call
 * instead would leave a tool result with nothing to answer, which the
 * server rejects.
 */
function parseArguments(raw: string): Record<string, unknown> {
	if (!raw) return {}
	try {
		const parsed: unknown = JSON.parse(raw)
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

function toWireMessages(messages: ChatCompletionParams['messages']): WireMessage[] {
	const toolNames = indexToolNames(messages)

	return messages.map((msg): WireMessage => {
		if (msg.role === 'tool') {
			const { text, images } = splitToolResult(msg.content)
			const name = toolNames.get(msg.toolCallId)
			return {
				role: 'tool',
				content: text,
				...(name !== undefined ? { tool_name: name } : {}),
				...(images.length > 0 ? { images } : {}),
			}
		}

		if (msg.role === 'assistant') {
			const calls: WireToolCall[] = (msg.toolCalls ?? []).map((call) => ({
				function: {
					name: call.function.name,
					arguments: parseArguments(call.function.arguments),
				},
			}))
			// The reasoning block is replayed as the model produced it. The
			// wire has one thinking field per turn, so multiple blocks join.
			const thinking = (msg.reasoning ?? [])
				.map((block) => block.text ?? '')
				.filter((text) => text.length > 0)
				.join('\n')
			return {
				role: 'assistant',
				content: msg.content ?? '',
				...(calls.length > 0 ? { tool_calls: calls } : {}),
				...(thinking.length > 0 ? { thinking } : {}),
			}
		}

		if (msg.role === 'user') {
			const images = (msg.attachments ?? [])
				.filter((attachment) => isCarriableImage(attachment.mediaType))
				.map((attachment) => attachment.data)
			const dropped = (msg.attachments ?? []).filter(
				(attachment) => !isCarriableImage(attachment.mediaType),
			)
			const notes = dropped.map(
				(attachment) =>
					`[${attachment.type ?? 'image'}: ${attachment.mediaType} — unsupported format, not sent]`,
			)
			const content = [msg.content, ...notes].filter((part) => part.length > 0).join('\n')
			return {
				role: 'user',
				content,
				...(images.length > 0 ? { images } : {}),
			}
		}

		return { role: msg.role, content: msg.content }
	})
}

function toWireTools(tools: ChatCompletionParams['tools']): WireTool[] | undefined {
	if (!tools || tools.length === 0) return undefined
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters as WireTool['function']['parameters'],
		},
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
	readonly capabilities = OLLAMA_CAPABILITIES

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
		if (params.frequencyPenalty !== undefined) options.frequency_penalty = params.frequencyPenalty
		if (params.presencePenalty !== undefined) options.presence_penalty = params.presencePenalty
		if (params.repetitionPenalty !== undefined) options.repeat_penalty = params.repetitionPenalty
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
		const messages = toWireMessages(params.messages)
		const options = this.buildOptions(params)
		const tools = toWireTools(params.tools)
		const think = params.thinking?.type === 'enabled' ? true : undefined

		const stream = await this.client.chat({
			model,
			messages,
			stream: true,
			...(Object.keys(options).length > 0 ? { options } : {}),
			...(tools ? { tools } : {}),
			...(think !== undefined ? { think } : {}),
			...(params.responseFormat?.type === 'json_object' ? { format: 'json' } : {}),
			...(params.responseFormat?.type === 'json_schema'
				? { format: params.responseFormat.json_schema.schema }
				: {}),
		})

		// Wire the caller abort to the iterator's real teardown: `stream.abort()`
		// calls the underlying AbortController so the fetch is cancelled and the
		// server stops generating. A bare for-await `.return()` does NOT
		// release the connection (the SDK's reader loop has no teardown), so
		// without this a Stop leaves the model generating. No-op / byte-identical
		// when the signal never aborts.
		const signal = params.signal
		const onAbort = () => stream.abort()
		if (signal?.aborted) stream.abort()
		else signal?.addEventListener('abort', onAbort, { once: true })

		const id = randomUUID()
		// A tool call arrives whole on this wire — the server parses the
		// model's call syntax before emitting it, so `arguments` is an
		// object, not a fragment stream. The index is still assigned per
		// call because the runtime buckets by it and a turn may carry
		// several calls, arriving in one chunk or spread across chunks.
		let nextToolIndex = 0
		let sawThinking = false
		let thinkingClosed = false

		try {
			for await (const chunk of stream) {
				signal?.throwIfAborted()

				const thinking = chunk.message?.thinking
				if (thinking && thinking.length > 0) {
					sawThinking = true
					yield { id, delta: { reasoning: { index: 0, type: 'thinking', text: thinking } } }
				}

				const content = chunk.message?.content
				if (content && content.length > 0) {
					// The reasoning block ends where the answer begins. The wire
					// has no explicit boundary, so the first answer token is it.
					if (sawThinking && !thinkingClosed) {
						thinkingClosed = true
						yield { id, delta: { reasoning: { index: 0, done: true } } }
					}
					yield { id, delta: { content } }
				}

				for (const call of chunk.message?.tool_calls ?? []) {
					const index = nextToolIndex++
					// The wire carries no call id. The runtime needs one to bind
					// a result to its call, so the driver mints it — stable
					// within the turn, which is the whole lifetime of the bind.
					const callId = `${id}-${index}`
					yield {
						id,
						delta: {
							toolCalls: [
								{
									index,
									id: callId,
									type: 'function',
									function: {
										name: call.function.name,
										arguments: JSON.stringify(call.function.arguments ?? {}),
									},
								},
							],
							// Complete on arrival, so the boundary is known now
							// rather than inferred at end-of-stream. This is what
							// lets the runtime emit `tool_input_completed` for the
							// first call while the second is still coming.
							toolCallEnd: { index, id: callId },
						},
					}
				}

				if (chunk.done === true) {
					if (sawThinking && !thinkingClosed) {
						thinkingClosed = true
						yield { id, delta: { reasoning: { index: 0, done: true } } }
					}
					yield {
						id,
						delta: {},
						finishReason:
							nextToolIndex > 0 ? 'tool_calls' : chunk.done_reason === 'length' ? 'length' : 'stop',
						usage: buildUsage(chunk),
					}
				}
			}
		} finally {
			signal?.removeEventListener('abort', onAbort)
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
			// Whether a given local model was trained for tool use is a
			// property of the model, not of this driver, and the listing does
			// not report it. The driver speaks the tool wire either way.
			supportsToolUse: true,
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
