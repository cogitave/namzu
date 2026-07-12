import Anthropic, {
	APIConnectionError,
	APIError,
	APIUserAbortError,
	AuthenticationError,
	BadRequestError,
	InternalServerError,
	PermissionDeniedError,
	RateLimitError,
} from '@anthropic-ai/sdk'
import { ProviderRequestError, classifyHttpStatus } from '@namzu/sdk'
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
// Error mapping: @anthropic-ai/sdk error classes → ProviderRequestError taxonomy
// --------------------------------------------------------------------------------------

/**
 * Derive a `retryAfterMs` from the response headers on a vendor error. Prefers
 * the standard `Retry-After` (delta-seconds or an HTTP-date), then falls back to
 * Anthropic's `anthropic-ratelimit-*-reset` headers, which carry the reset
 * instant as an RFC 3339 timestamp.
 */
function readRetryAfterMs(headers: Headers | undefined): number | undefined {
	if (!headers) return undefined

	const retryAfter = headers.get('retry-after')
	if (retryAfter) {
		const asSeconds = Number(retryAfter)
		if (Number.isFinite(asSeconds)) return Math.max(0, Math.round(asSeconds * 1000))
		const asDate = Date.parse(retryAfter)
		if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now())
	}

	for (const name of [
		'anthropic-ratelimit-tokens-reset',
		'anthropic-ratelimit-input-tokens-reset',
		'anthropic-ratelimit-output-tokens-reset',
		'anthropic-ratelimit-requests-reset',
	]) {
		const reset = headers.get(name)
		if (reset) {
			const at = Date.parse(reset)
			if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
		}
	}

	return undefined
}

/**
 * Anthropic signals an over-long *prompt* as a 400 `invalid_request_error` whose
 * message reads "prompt is too long: N tokens > M maximum". There is no
 * dedicated error code, so we key on that INPUT-overflow-specific message text —
 * inspecting the structured body first, then the derived `Error.message` as a
 * fallback.
 *
 * Deliberately NOT a broad `'maximum' && 'token'` match: a `max_tokens` config
 * error ("max_tokens: N > M, which is the maximum allowed number of output
 * tokens...") also mentions both words but is a plain `bad_request`, not context
 * overflow. Routing it here would trigger destructive reactive compaction on a
 * request that can never succeed. Ambiguity resolves to `bad_request` — failing
 * fast beats shredding healthy run history (ses_015 fix-batch).
 */
function isContextOverflow(err: BadRequestError): boolean {
	const body = err.error as { error?: { message?: unknown } } | undefined
	const bodyMessage = typeof body?.error?.message === 'string' ? body.error.message : ''
	const haystack = `${bodyMessage} ${err.message}`.toLowerCase()
	return (
		haystack.includes('prompt is too long') ||
		haystack.includes('too many tokens') ||
		haystack.includes('context window') ||
		haystack.includes('context length')
	)
}

/**
 * Translate any error thrown by the vendor SDK into a {@link ProviderRequestError}
 * so the runtime loop can classify retries without knowing about Anthropic. The
 * order matters: every branch except the last two tests an `APIError` subclass,
 * and subclasses are checked before their `APIError` base.
 */
function mapAnthropicError(err: unknown, providerId: string): ProviderRequestError {
	if (err instanceof APIUserAbortError) {
		return new ProviderRequestError('Anthropic request was aborted', {
			kind: 'aborted',
			providerId,
			cause: err,
		})
	}
	// A DOMException abort that reached us before the SDK wrapped it.
	if (err instanceof Error && err.name === 'AbortError') {
		return new ProviderRequestError(err.message, { kind: 'aborted', providerId, cause: err })
	}
	if (err instanceof RateLimitError) {
		return new ProviderRequestError(err.message, {
			kind: 'throttle',
			status: err.status,
			retryAfterMs: readRetryAfterMs(err.headers),
			providerId,
			cause: err,
		})
	}
	// Covers APIConnectionTimeoutError too (it is a subclass).
	if (err instanceof APIConnectionError) {
		return new ProviderRequestError(err.message, { kind: 'network', providerId, cause: err })
	}
	if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
		return new ProviderRequestError(err.message, {
			kind: 'auth',
			status: err.status,
			providerId,
			cause: err,
		})
	}
	if (err instanceof BadRequestError) {
		return new ProviderRequestError(err.message, {
			kind: isContextOverflow(err) ? 'context_overflow' : 'bad_request',
			status: err.status,
			providerId,
			cause: err,
		})
	}
	if (err instanceof InternalServerError) {
		return new ProviderRequestError(err.message, {
			kind: 'server',
			status: err.status,
			retryAfterMs: readRetryAfterMs(err.headers),
			providerId,
			cause: err,
		})
	}
	// Any remaining typed status error (404/409/422/…): classify by status.
	if (err instanceof APIError) {
		const status = typeof err.status === 'number' ? err.status : undefined
		return new ProviderRequestError(err.message, {
			kind: status === undefined ? 'unknown' : classifyHttpStatus(status),
			status,
			retryAfterMs: readRetryAfterMs(err.headers),
			providerId,
			cause: err,
		})
	}
	const message = err instanceof Error ? err.message : String(err)
	return new ProviderRequestError(message, { kind: 'unknown', providerId, cause: err })
}

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
// Response content extraction
// --------------------------------------------------------------------------------------

interface RawAnthropicResponseBlock {
	type: string
	text?: string
	id?: string
	name?: string
	input?: unknown
}

function extractResponseContent(content?: RawAnthropicResponseBlock[]): {
	text: string | null
	toolCalls: ChatCompletionResponse['message']['toolCalls']
} {
	if (!content || content.length === 0) return { text: null, toolCalls: undefined }

	let text: string | null = null
	const toolCalls: NonNullable<ChatCompletionResponse['message']['toolCalls']> = []

	for (const block of content) {
		if (block.type === 'text' && typeof block.text === 'string') {
			text = (text ?? '') + block.text
		} else if (block.type === 'tool_use') {
			toolCalls.push({
				id: block.id ?? `tool-${Date.now()}`,
				type: 'function',
				function: {
					name: block.name ?? '',
					arguments: JSON.stringify(block.input ?? {}),
				},
			})
		}
	}

	return {
		text,
		toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
	 *
	 * The caller's `signal` and `maxRetries: 0` are passed via the second
	 * `RequestOptions` argument: `maxRetries: 0` disables the vendor SDK's own
	 * retry loop so namzu's retry cap alone bounds the number of physical
	 * attempts.
	 */
	private createRaw(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const create = this.client.messages.create as unknown as (
			body: Record<string, unknown>,
			options: { signal?: AbortSignal; maxRetries: number },
		) => Promise<unknown>
		return create.call(this.client.messages, body, { signal, maxRetries: 0 })
	}

	async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
		const createParams = this.buildCreateParams(params, false)

		let raw: unknown
		try {
			raw = await this.createRaw(createParams, params.signal)
		} catch (err) {
			throw mapAnthropicError(err, this.id)
		}
		const response = raw as {
			id?: string
			model?: string
			content: RawAnthropicResponseBlock[]
			stop_reason?: string | null
			usage?: RawAnthropicUsage
		}

		const { text, toolCalls } = extractResponseContent(response.content)

		return {
			id: response.id ?? `anthropic-${Date.now()}`,
			model: response.model ?? this.resolveModel(params),
			message: {
				role: 'assistant',
				content: text,
				toolCalls,
			},
			finishReason: mapStopReason(response.stop_reason),
			usage: parseUsage(response.usage),
		}
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const createParams = this.buildCreateParams(params, true)

		let stream: AsyncIterable<StreamEvent>
		try {
			stream = (await this.createRaw(createParams, params.signal)) as AsyncIterable<StreamEvent>
		} catch (err) {
			throw mapAnthropicError(err, this.id)
		}

		let messageId = ''
		// Track active tool-use blocks by content_block index so input_json_delta
		// fragments can reference the right tool call.
		const activeTools = new Map<number, { id: string; name: string }>()

		// Wrap the whole iteration so an error thrown while advancing the vendor
		// stream (mid-stream abort → 'aborted', connection drop → 'network', an
		// overloaded event → 'server') is mapped onto the ProviderRequestError
		// taxonomy instead of escaping as a raw vendor error. The inner try/catch
		// below still turns a single malformed event into an error chunk without
		// tearing down the stream (ses_015 fix-batch).
		try {
			for await (const event of stream) {
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
						case 'content_block_stop':
							// Aggregation is consumer-side — nothing to emit.
							break
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
		} catch (err) {
			throw mapAnthropicError(err, this.id)
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
