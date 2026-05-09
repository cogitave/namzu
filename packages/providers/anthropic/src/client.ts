import Anthropic from '@anthropic-ai/sdk'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	StreamChunk,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import type { AnthropicConfig } from './types.js'

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_TIMEOUT_MS = 120_000

// --------------------------------------------------------------------------------------
// Message translation: @namzu/sdk → Anthropic Messages API
// --------------------------------------------------------------------------------------

interface AnthropicTextBlock {
	type: 'text'
	text: string
}

interface AnthropicToolUseBlock {
	type: 'tool_use'
	id: string
	name: string
	input: unknown
}

interface AnthropicToolResultBlock {
	type: 'tool_result'
	tool_use_id: string
	content: string
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock

interface AnthropicMessageParam {
	role: 'user' | 'assistant'
	content: string | AnthropicContentBlock[]
}

function extractSystem(messages: ChatCompletionParams['messages']): string | undefined {
	const parts: string[] = []
	for (const msg of messages) {
		if (msg.role === 'system' && typeof msg.content === 'string') {
			parts.push(msg.content)
		}
	}
	return parts.length > 0 ? parts.join('\n\n') : undefined
}

function toAnthropicMessages(messages: ChatCompletionParams['messages']): AnthropicMessageParam[] {
	const out: AnthropicMessageParam[] = []
	let pendingToolResults: AnthropicToolResultBlock[] = []

	const flushToolResults = () => {
		if (pendingToolResults.length > 0) {
			out.push({ role: 'user', content: pendingToolResults })
			pendingToolResults = []
		}
	}

	for (const msg of messages) {
		if (msg.role === 'system') continue

		if (msg.role === 'tool') {
			const toolMsg = msg as { toolCallId?: string; content?: unknown }
			pendingToolResults.push({
				type: 'tool_result',
				tool_use_id: toolMsg.toolCallId ?? 'unknown',
				content:
					typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content),
			})
			continue
		}

		flushToolResults()

		if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
			const blocks: AnthropicContentBlock[] = []
			if (msg.content && typeof msg.content === 'string') {
				blocks.push({ type: 'text', text: msg.content })
			}
			for (const tc of msg.toolCalls) {
				let parsedInput: unknown = {}
				try {
					parsedInput = JSON.parse(tc.function.arguments || '{}')
				} catch {
					parsedInput = {}
				}
				blocks.push({
					type: 'tool_use',
					id: tc.id,
					name: tc.function.name,
					input: parsedInput,
				})
			}
			out.push({ role: 'assistant', content: blocks })
			continue
		}

		const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
		out.push({
			role: msg.role === 'assistant' ? 'assistant' : 'user',
			content,
		})
	}

	flushToolResults()
	return out
}

function toAnthropicTools(params: ChatCompletionParams): unknown[] | undefined {
	if (!params.tools || params.tools.length === 0) return undefined
	return params.tools.map((t) => ({
		name: t.function.name,
		description: t.function.description ?? '',
		input_schema: t.function.parameters ?? { type: 'object' },
	}))
}

function toAnthropicToolChoice(tc?: ToolChoice): unknown {
	if (tc === undefined) return undefined
	if (tc === 'auto') return { type: 'auto' }
	if (tc === 'required') return { type: 'any' }
	// 'none' — Anthropic has no direct equivalent. Map to auto (omitting tools at call-site
	// is the proper way to forbid tool use); we leave it as auto here for safety.
	if (tc === 'none') return { type: 'auto' }
	if (typeof tc === 'object' && tc.type === 'function') {
		return { type: 'tool', name: tc.function.name }
	}
	return undefined
}

// --------------------------------------------------------------------------------------
// Usage parsing
// --------------------------------------------------------------------------------------

interface RawAnthropicUsage {
	input_tokens?: number
	output_tokens?: number
	cache_read_input_tokens?: number | null
	cache_creation_input_tokens?: number | null
}

function emptyUsage(): TokenUsage {
	return {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

function parseUsage(raw?: RawAnthropicUsage): TokenUsage {
	if (!raw) return emptyUsage()
	const input = raw.input_tokens ?? 0
	const output = raw.output_tokens ?? 0
	return {
		promptTokens: input,
		completionTokens: output,
		totalTokens: input + output,
		cachedTokens: raw.cache_read_input_tokens ?? 0,
		cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
	}
}

// --------------------------------------------------------------------------------------
// Finish reason mapping
// --------------------------------------------------------------------------------------

type NamzuFinishReason = ChatCompletionResponse['finishReason']

function mapStopReason(reason?: string | null): NamzuFinishReason {
	switch (reason) {
		case 'end_turn':
		case 'stop_sequence':
			return 'stop'
		case 'tool_use':
			return 'tool_calls'
		case 'max_tokens':
			return 'length'
		default:
			return 'stop'
	}
}

// --------------------------------------------------------------------------------------
// Stream event types
// --------------------------------------------------------------------------------------

interface StreamEvent {
	type: string
	message?: { id?: string; usage?: RawAnthropicUsage }
	index?: number
	content_block?: { type?: string; id?: string; name?: string }
	delta?: {
		type?: string
		text?: string
		partial_json?: string
		stop_reason?: string | null
	}
	usage?: RawAnthropicUsage
}

// --------------------------------------------------------------------------------------
// AnthropicProvider
// --------------------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
	readonly id = 'anthropic'
	readonly name = 'Anthropic'

	private client: Anthropic
	private config: AnthropicConfig

	constructor(config: AnthropicConfig) {
		if (!config.apiKey) {
			throw new Error('AnthropicProvider: apiKey is required')
		}
		this.config = config

		const clientOpts: Record<string, unknown> = {
			apiKey: config.apiKey,
			timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
		}
		if (config.baseURL) clientOpts.baseURL = config.baseURL
		if (config.defaultHeaders) clientOpts.defaultHeaders = config.defaultHeaders

		this.client = new Anthropic(clientOpts)
	}

	private resolveModel(params: ChatCompletionParams): string {
		const model = params.model || this.config.model
		if (!model) {
			throw new Error(
				'AnthropicProvider: no model specified. Pass `model` on the chat params or set a default via config.',
			)
		}
		return model
	}

	private buildCreateParams(
		params: ChatCompletionParams,
		stream: boolean,
	): Record<string, unknown> {
		const system = extractSystem(params.messages)
		const messages = toAnthropicMessages(params.messages)
		const tools = toAnthropicTools(params)
		const toolChoice = toAnthropicToolChoice(params.toolChoice)

		const body: Record<string, unknown> = {
			model: this.resolveModel(params),
			messages,
			max_tokens: params.maxTokens ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
			stream,
		}

		if (system) body.system = system
		if (tools) body.tools = tools
		if (toolChoice) body.tool_choice = toolChoice
		if (params.temperature !== undefined) body.temperature = params.temperature
		if (params.topP !== undefined) body.top_p = params.topP
		if (params.topK !== undefined) body.top_k = params.topK
		if (params.stop) body.stop_sequences = params.stop

		return body
	}

	/**
	 * The SDK's `messages.create` is overloaded on the `stream` flag. We build
	 * the request as an untyped object bag and narrow the response shape ourselves.
	 * Casting via `unknown` keeps us out of `any` territory while acknowledging
	 * that the translation layer bridges two type worlds.
	 */
	private createRaw(body: Record<string, unknown>): Promise<unknown> {
		const create = this.client.messages.create as unknown as (
			body: Record<string, unknown>,
		) => Promise<unknown>
		return create.call(this.client.messages, body)
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const createParams = this.buildCreateParams(params, true)

		const stream = (await this.createRaw(createParams)) as AsyncIterable<StreamEvent>

		let messageId = ''
		// Track active tool-use blocks by content_block index so input_json_delta
		// fragments can reference the right tool call.
		const activeTools = new Map<number, { id: string; name: string }>()

		// Anthropic Messages API streams over SSE. Live debugging surfaced
		// runs where the upstream SSE went silent for > 1 hour without
		// returning a `message_stop` or throwing — `for await (event of
		// stream)` blocks forever, and the SDK's overall request `timeout`
		// option is per-call, not per-event.
		//
		// Treat sustained silence as a transport error so the higher
		// layers' existing terminal markers fire naturally:
		//   provider yields error → SDK iteration catches →
		//   `ResultAssembler.handleError` emits `run_failed` →
		//   `supervisor.run()` rejects → outer runtime settles status to
		//   'terminated'. We are not adding a watchdog at the supervisor
		//   level; we are making the provider correctly recognize a
		//   stalled HTTP/2 SSE as a failure, which is the boundary where
		//   the network condition is observable.
		//
		// On timeout we also call `iter.return()` so the underlying
		// HTTP/2 connection is released instead of leaking until the OS
		// times it out — Codex's audit flagged the bare-timer version
		// as correct-but-leaky.
		const STREAM_IDLE_TIMEOUT_MS = 90_000
		const iter = (stream as AsyncIterable<StreamEvent>)[Symbol.asyncIterator]()
		const nextWithIdleTimeout = async (): Promise<IteratorResult<StreamEvent>> => {
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				return await Promise.race([
					iter.next(),
					new Promise<IteratorResult<StreamEvent>>((_, reject) => {
						timer = setTimeout(() => {
							reject(
								new Error(
									`Anthropic stream idle for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s — aborting so the run lifecycle can emit run_failed.`,
								),
							)
						}, STREAM_IDLE_TIMEOUT_MS)
					}),
				])
			} finally {
				if (timer !== undefined) clearTimeout(timer)
			}
		}

		try {
			for (;;) {
				const result = await nextWithIdleTimeout()
				if (result.done) break
				const event = result.value
				try {
					switch (event.type) {
						case 'message_start': {
							if (event.message?.id) messageId = event.message.id
							if (event.message?.usage) {
								yield {
									id: messageId,
									delta: {},
									usage: parseUsage(event.message.usage),
								}
							}
							break
						}
						case 'content_block_start': {
							const idx = event.index ?? 0
							const block = event.content_block
							if (block?.type === 'tool_use') {
								const toolId = block.id ?? `tool-${Date.now()}`
								activeTools.set(idx, { id: toolId, name: block.name ?? '' })
								yield {
									id: messageId,
									delta: {
										toolCalls: [
											{
												index: idx,
												id: toolId,
												type: 'function',
												function: { name: block.name ?? '' },
											},
										],
									},
								}
							}
							break
						}
						case 'content_block_delta': {
							const idx = event.index ?? 0
							const delta = event.delta
							if (delta?.type === 'text_delta' && delta.text) {
								yield { id: messageId, delta: { content: delta.text } }
							} else if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
								const active = activeTools.get(idx)
								yield {
									id: messageId,
									delta: {
										toolCalls: [
											{
												index: idx,
												id: active?.id,
												function: { arguments: delta.partial_json },
											},
										],
									},
								}
							}
							break
						}
						case 'content_block_stop': {
							// For tool_use blocks we MUST emit a `toolCallEnd`
							// signal so the consumer-side aggregator (sdk
							// runtime/query/iteration) can flush the buffered
							// `argsBuf` and JSON.parse it into the tool input.
							// Without this signal the executor sees an empty
							// `arguments` string and rejects the call with
							// `Error: Invalid JSON in tool arguments for "<tool>"`
							// — exactly the failure the live cowork test
							// surfaced (Bash + Write both blank-input failed).
							const idx = event.index ?? 0
							const active = activeTools.get(idx)
							if (active) {
								yield {
									id: messageId,
									delta: {
										toolCallEnd: { index: idx, id: active.id },
									},
								}
								activeTools.delete(idx)
							}
							break
						}
						case 'message_delta': {
							if (event.delta?.stop_reason) {
								yield {
									id: messageId,
									delta: {},
									finishReason: mapStopReason(event.delta.stop_reason),
									usage: event.usage ? parseUsage(event.usage) : undefined,
								}
							} else if (event.usage) {
								yield {
									id: messageId,
									delta: {},
									usage: parseUsage(event.usage),
								}
							}
							break
						}
						case 'message_stop':
							return
						default:
							// Ignore unknown / ping / opaque events.
							break
					}
				} catch (parseErr) {
					yield {
						id: messageId,
						delta: {},
						error: `Stream event error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
					}
				}
			}
		} finally {
			// Always release the underlying HTTP/2 connection — both on
			// idle-timeout rejection (bubbling up) and on normal stream
			// end (`message_stop` returned out of the loop). Leaving
			// the SSE connection open until OS-level timeout was the
			// gap Codex called out.
			await iter.return?.().catch(() => undefined)
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		try {
			// Models API shipped in SDK ~0.32+. Feature-detect via unknown cast so we
			// don't depend on the SDK's surface-level shape in a version-brittle way.
			const clientLike = this.client as unknown as {
				models?: { list?: (opts: { limit: number }) => Promise<unknown> }
			}
			const listFn = clientLike.models?.list
			if (typeof listFn !== 'function') {
				return this.knownModels()
			}
			const page = (await listFn({ limit: 100 })) as {
				data?: Array<{ id?: string; display_name?: string; type?: string }>
			}
			const data = page?.data ?? []
			if (data.length === 0) return this.knownModels()
			return data.map((m) => ({
				id: m.id ?? '',
				name: m.display_name ?? m.id ?? '',
				contextWindow: 0,
				maxOutputTokens: 0,
				inputPrice: 0,
				outputPrice: 0,
				supportsToolUse: true,
				supportsStreaming: true,
			}))
		} catch {
			return this.knownModels()
		}
	}

	private knownModels(): ModelInfo[] {
		return [
			{
				id: 'claude-sonnet-4-5-20250929',
				name: 'Claude Sonnet 4.5',
				contextWindow: 200_000,
				maxOutputTokens: 64_000,
				inputPrice: 3.0,
				outputPrice: 15.0,
				supportsToolUse: true,
				supportsStreaming: true,
			},
			{
				id: 'claude-opus-4-1-20250805',
				name: 'Claude Opus 4.1',
				contextWindow: 200_000,
				maxOutputTokens: 32_000,
				inputPrice: 15.0,
				outputPrice: 75.0,
				supportsToolUse: true,
				supportsStreaming: true,
			},
			{
				id: 'claude-haiku-4-5-20251001',
				name: 'Claude Haiku 4.5',
				contextWindow: 200_000,
				maxOutputTokens: 64_000,
				inputPrice: 1.0,
				outputPrice: 5.0,
				supportsToolUse: true,
				supportsStreaming: true,
			},
		]
	}

	async healthCheck(): Promise<boolean> {
		// The client constructor validates the apiKey shape lazily. A no-op
		// check is sufficient here — a real request costs tokens. Callers that
		// want network-level verification should call `chat()` directly.
		return Boolean(this.client) && Boolean(this.config.apiKey)
	}
}
