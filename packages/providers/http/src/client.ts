import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelIdGrammar,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	TokenUsage,
	ToolChoice,
	ToolResultContent,
} from '@namzu/sdk'
import {
	ProviderRequestError,
	assertStrictSchema,
	assertThinkingUnsupported,
	isCallerAbortError,
	modelVersionAtLeast,
	providerHttpError,
	providerVendorError,
	toSchemaDialect,
	toolResultToText,
} from '@namzu/sdk'
import { attributionHeaders } from '@namzu/sdk'
import { DialectMismatchError, type HttpConfig, type HttpDialect } from './types.js'

const DEFAULT_TIMEOUT_MS = 60_000

// --------------------------------------------------------------------------------------
// Usage parsing
// --------------------------------------------------------------------------------------

interface OpenAIUsage {
	prompt_tokens: number
	completion_tokens: number
	total_tokens: number
	prompt_tokens_details?: { cached_tokens?: number }
	cache_read_input_tokens?: number
	cache_creation_input_tokens?: number
}

interface AnthropicUsage {
	input_tokens: number
	output_tokens: number
	cache_read_input_tokens?: number
	cache_creation_input_tokens?: number
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

function parseOpenAIUsage(raw?: OpenAIUsage): TokenUsage {
	if (!raw) return emptyUsage()
	return {
		promptTokens: raw.prompt_tokens,
		completionTokens: raw.completion_tokens,
		totalTokens: raw.total_tokens,
		cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? 0,
		cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
	}
}

function parseAnthropicUsage(raw?: AnthropicUsage): TokenUsage {
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
// Shared helpers
// --------------------------------------------------------------------------------------

function formatToolChoice(tc: ToolChoice | undefined): unknown {
	if (tc === undefined) return undefined
	return tc
}

/**
 * The vocabulary this gateway's ids may be spelled in.
 *
 * Declared here rather than imported from the dedicated driver because
 * drivers are siblings and nothing may import across that level. Duplicating
 * five words is the cost of the dependency direction; the MATCHER is shared,
 * which is what mattered — this file's own copy of it read the 8-digit date
 * suffix as the minor version.
 */
const MODEL_ID_GRAMMAR: ModelIdGrammar = {
	product: 'claude',
	families: ['haiku', 'sonnet', 'opus', 'fable', 'mythos'],
	routingPrefix: 'anthropic/',
}

function shouldUseStrictToolInputs(
	model: string,
	mode: HttpConfig['strictToolUse'] = 'auto',
): boolean {
	if (mode === 'on') return true
	if (mode === 'off') return false

	const normalized = model.toLowerCase()
	if (/^(?:anthropic\/)?claude-mythos-preview$/.test(normalized)) return true
	return modelVersionAtLeast(normalized, MODEL_ID_GRAMMAR, 4, 5)
}

function joinUrl(base: string, path: string): string {
	const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base
	const trimmedPath = path.startsWith('/') ? path : `/${path}`
	return `${trimmedBase}${trimmedPath}`
}

type NamzuFinishReason = ChatCompletionResponse['finishReason']

function mapAnthropicStopReason(reason?: string | null): NamzuFinishReason {
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
// OpenAI dialect — request construction
// --------------------------------------------------------------------------------------

function formatOpenAIMessages(messages: ChatCompletionParams['messages']): unknown[] {
	return messages.map((msg) => {
		if (msg.role === 'tool') {
			return {
				role: 'tool',
				// Tool messages are text-only on this wire. The raw content was
				// passed straight through, so a result carrying an image put
				// its base64 into the prompt: the model paid for every
				// character, could read none of them, and read a serialized
				// object where a picture should be with nothing saying so.
				content: toolResultToText(msg.content ?? ''),
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

function buildOpenAIBody(
	params: ChatCompletionParams,
	stream: boolean,
	defaultModel?: string,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: params.model || defaultModel,
		messages: formatOpenAIMessages(params.messages),
		stream,
	}

	if (params.tools && params.tools.length > 0) body.tools = params.tools
	const toolChoice = formatToolChoice(params.toolChoice)
	if (toolChoice !== undefined) body.tool_choice = toolChoice
	if (params.parallelToolCalls !== undefined) body.parallel_tool_calls = params.parallelToolCalls

	if (params.temperature !== undefined) body.temperature = params.temperature
	if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens
	if (params.topP !== undefined) body.top_p = params.topP
	if (params.topK !== undefined) body.top_k = params.topK
	if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty
	if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty
	if (params.repetitionPenalty !== undefined) body.repetition_penalty = params.repetitionPenalty
	if (params.stop) body.stop = params.stop

	if (params.responseFormat) body.response_format = params.responseFormat

	return body
}

// --------------------------------------------------------------------------------------
// Anthropic dialect — request construction
// --------------------------------------------------------------------------------------

interface AnthropicContentBlock {
	type: 'text' | 'tool_use' | 'tool_result'
	text?: string
	id?: string
	name?: string
	input?: unknown
	tool_use_id?: string
	content?: unknown
}

interface AnthropicMessage {
	role: 'user' | 'assistant'
	content: string | AnthropicContentBlock[]
}

function formatAnthropicRequest(
	params: ChatCompletionParams,
	stream: boolean,
	defaultModel?: string,
	strictToolUse: HttpConfig['strictToolUse'] = 'auto',
): Record<string, unknown> {
	const systemParts: string[] = []
	const messages: AnthropicMessage[] = []
	let pendingToolResults: AnthropicContentBlock[] = []
	const model = params.model || defaultModel

	const flushToolResults = () => {
		if (pendingToolResults.length > 0) {
			messages.push({ role: 'user', content: pendingToolResults })
			pendingToolResults = []
		}
	}

	for (const msg of params.messages) {
		if (msg.role === 'system') {
			if (typeof msg.content === 'string') systemParts.push(msg.content)
			continue
		}

		if (msg.role === 'tool') {
			const toolMsg = msg as { toolCallId?: string; content?: ToolResultContent }
			pendingToolResults.push({
				type: 'tool_result',
				tool_use_id: toolMsg.toolCallId ?? 'unknown',
				// Same degrade as the sibling dialect: the named placeholder
				// rather than a JSON dump of the payload.
				content: toolResultToText(toolMsg.content ?? ''),
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
			messages.push({ role: 'assistant', content: blocks })
			continue
		}

		const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
		messages.push({
			role: msg.role === 'assistant' ? 'assistant' : 'user',
			content,
		})
	}

	flushToolResults()

	const body: Record<string, unknown> = {
		model,
		messages,
		// Anthropic requires max_tokens. Default to 4096 if the caller didn't set one.
		max_tokens: params.maxTokens ?? 4096,
		stream,
	}

	if (systemParts.length > 0) body.system = systemParts.join('\n\n')
	if (params.temperature !== undefined) body.temperature = params.temperature
	if (params.topP !== undefined) body.top_p = params.topP
	if (params.topK !== undefined) body.top_k = params.topK
	if (params.stop) body.stop_sequences = params.stop

	// 'none' means the model must not call a tool. Mapping it to the wire's
	// 'auto' said it MAY, so a caller that had forbidden tool use got a
	// request that permitted it. Omitting the tools is the guarantee.
	const toolsForbidden = params.toolChoice === 'none'

	if (params.tools && params.tools.length > 0 && !toolsForbidden) {
		const enforcedNames = new Set(params.enforceToolInputSchema ?? [])
		const strictEnabled = shouldUseStrictToolInputs(model ?? '', strictToolUse)
		body.tools = params.tools.map((t) => {
			const strict = strictEnabled && enforcedNames.has(t.function.name)
			// The registry refuses an unexpressible schema at declaration, which
			// is where the fix belongs. This is the second boundary: a host may
			// build `ChatCompletionParams` by hand and never touch the registry,
			// and a strict flag on a schema the subset cannot express does not
			// degrade one field — the vendor rejects the whole request.
			if (strict) assertStrictSchema(t.function.name, t.function.parameters)
			return {
				name: t.function.name,
				description: t.function.description ?? '',
				// The Anthropic dialect parses draft 2020-12 while the renderer
				// emits draft-07; they disagree about tuples and the wire
				// rejects the whole request over it. Only the OpenAI branch of
				// this file is left alone — that wire has not been measured, and
				// assuming one dialect fits every wire is the mistake being
				// fixed here.
				input_schema: toSchemaDialect(
					(t.function.parameters as Record<string, unknown> | undefined) ?? { type: 'object' },
					'2020-12',
				),
				...(strict ? { strict: true } : {}),
			}
		})
	}

	if (params.toolChoice !== undefined && !toolsForbidden) {
		const tc = params.toolChoice
		if (tc === 'auto') body.tool_choice = { type: 'auto' }
		else if (tc === 'required') body.tool_choice = { type: 'any' }
		else if (typeof tc === 'object' && tc.type === 'function') {
			body.tool_choice = { type: 'tool', name: tc.function.name }
		}
	}

	return body
}

// --------------------------------------------------------------------------------------
// HttpProvider
// --------------------------------------------------------------------------------------

/**
 * What this DRIVER does, not what the remote endpoint could do:
 * tools pass through to the request body, but user-message image
 * `attachments` are not mapped into content parts — `supportsVision`
 * stays false until the message translation handles them.
 */
export const HTTP_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: false,
	// Images only. A document degrades to a named placeholder.
	supportsDocuments: false,
}

export class HttpProvider implements LLMProvider {
	readonly id = 'http'
	readonly name = 'HTTP'
	readonly capabilities = HTTP_CAPABILITIES

	private config: HttpConfig
	private dialect: HttpDialect

	constructor(config: HttpConfig) {
		if (!config.baseURL) {
			throw new Error('HttpProvider: baseURL is required')
		}
		this.config = config
		this.dialect = config.dialect ?? 'openai'
	}

	private getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			// First: `config.headers` is merged last below, so a host keeps
			// the final word on every key including this one.
			...attributionHeaders(),
			'Content-Type': 'application/json',
		}
		if (this.dialect === 'anthropic') {
			if (this.config.apiKey) headers['x-api-key'] = this.config.apiKey
			headers['anthropic-version'] = '2023-06-01'
		} else if (this.config.apiKey) {
			headers.Authorization = `Bearer ${this.config.apiKey}`
		}
		if (this.config.headers) {
			for (const [k, v] of Object.entries(this.config.headers)) {
				headers[k] = v
			}
		}
		return headers
	}

	private endpoint(): string {
		return this.dialect === 'anthropic'
			? joinUrl(this.config.baseURL, '/messages')
			: joinUrl(this.config.baseURL, '/chat/completions')
	}

	private timeoutSignal(extra?: AbortSignal): AbortSignal {
		const timeout = AbortSignal.timeout(this.config.timeout ?? DEFAULT_TIMEOUT_MS)
		// Compose the caller abort with the request timeout so a Stop cancels the
		// fetch. No caller signal ⇒ the exact prior timeout-only expression.
		return extra ? AbortSignal.any([timeout, extra]) : timeout
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		assertThinkingUnsupported('HttpProvider', params)
		const url = this.endpoint()
		const body =
			this.dialect === 'anthropic'
				? formatAnthropicRequest(params, true, this.config.model, this.config.strictToolUse)
				: buildOpenAIBody(params, true, this.config.model)

		let response: Response
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: this.getHeaders(),
				body: JSON.stringify(body),
				signal: this.timeoutSignal(params.signal),
			})
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			throw providerVendorError({ providerId: 'http', error: err })
		}

		if (!response.ok) {
			// Body read to CLASSIFY, then dropped. It used to be interpolated into
			// the message together with the URL, so a credential the upstream echoed
			// back — or one embedded in the URL — reached every log that recorded the
			// failure. Proven with a planted fake token.
			const errorBody = await response.text().catch(() => '')
			throw providerHttpError({
				providerId: 'http',
				status: response.status,
				body: errorBody,
				retryAfter: response.headers.get('retry-after'),
			})
		}

		if (!response.body) {
			throw new ProviderRequestError({
				kind: 'server',
				providerId: 'http',
				status: response.status,
				detail: 'the response contained no stream body',
			})
		}

		if (this.dialect === 'anthropic') {
			yield* this.streamAnthropic(response.body, url, response.status, params.signal)
		} else {
			yield* this.streamOpenAI(response.body, url, response.status, params.signal)
		}
	}

	private async readStream(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
		try {
			return await reader.read()
		} catch (err) {
			if (isCallerAbortError(err, signal)) throw signal?.reason ?? err
			throw providerVendorError({ providerId: 'http', error: err })
		}
	}

	private async *streamOpenAI(
		body: ReadableStream<Uint8Array>,
		url: string,
		status: number,
		signal?: AbortSignal,
	): AsyncIterable<StreamChunk> {
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		let firstFrame = true

		try {
			while (true) {
				signal?.throwIfAborted()
				const { done, value } = await this.readStream(reader, signal)
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split('\n')
				buffer = lines.pop() ?? ''

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || !trimmed.startsWith('data: ')) continue
					const data = trimmed.slice(6)
					if (data === '[DONE]') return

					let parsed: unknown
					try {
						parsed = JSON.parse(data)
					} catch {
						// V8 includes a source snippet in SyntaxError.message. Never
						// place that message in a chunk or cause: the malformed frame
						// may contain a credential or request content.
						throw new ProviderRequestError({
							kind: 'server',
							providerId: 'http',
							detail: 'the provider stream returned malformed JSON',
						})
					}

					if (parsed && typeof parsed === 'object' && 'error' in parsed) {
						throw providerVendorError({
							providerId: 'http',
							error: new Error(data),
						})
					}

					if (firstFrame) {
						firstFrame = false
						if (
							!parsed ||
							typeof parsed !== 'object' ||
							!('choices' in parsed) ||
							!Array.isArray((parsed as { choices: unknown }).choices)
						) {
							throw new DialectMismatchError('openai', url, status, data)
						}
					}

					const obj = parsed as {
						id?: string
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
						usage?: OpenAIUsage
					}

					const choice = obj.choices[0]
					if (!choice) continue

					yield {
						id: obj.id ?? '',
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
						usage: obj.usage ? parseOpenAIUsage(obj.usage) : undefined,
					}
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	private async *streamAnthropic(
		body: ReadableStream<Uint8Array>,
		url: string,
		status: number,
		signal?: AbortSignal,
	): AsyncIterable<StreamChunk> {
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		let messageId = ''
		let firstFrame = true

		// Track active tool-use blocks by content_block index.
		const activeTools = new Map<number, { id: string; name: string }>()

		try {
			while (true) {
				signal?.throwIfAborted()
				const { done, value } = await this.readStream(reader, signal)
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				// Anthropic SSE frames are separated by blank lines.
				const frames = buffer.split('\n\n')
				buffer = frames.pop() ?? ''

				for (const frame of frames) {
					// Each frame has `event: <name>\ndata: <json>`. Extract the data line.
					const dataLine = frame
						.split('\n')
						.map((l) => l.trim())
						.find((l) => l.startsWith('data: '))
					if (!dataLine) continue
					const data = dataLine.slice(6)

					let parsed: unknown
					try {
						parsed = JSON.parse(data)
					} catch {
						// SyntaxError.message may quote the response fragment. Replace
						// it with an authored diagnostic and drop the raw frame.
						throw new ProviderRequestError({
							kind: 'server',
							providerId: 'http',
							detail: 'the provider stream returned malformed JSON',
						})
					}

					if (!parsed || typeof parsed !== 'object') continue
					const event = parsed as {
						type?: string
						message?: { id?: string; usage?: AnthropicUsage }
						index?: number
						content_block?: { type?: string; id?: string; name?: string }
						delta?: {
							type?: string
							text?: string
							partial_json?: string
							stop_reason?: string
						}
						usage?: AnthropicUsage
					}

					if (firstFrame) {
						firstFrame = false
						// First frame of an Anthropic stream must be `message_start`.
						// If we see an OpenAI-shape `choices` array instead, that's a dialect mismatch.
						if (event.type === undefined && 'choices' in (parsed as object)) {
							throw new DialectMismatchError('anthropic', url, status, data)
						}
					}

					switch (event.type) {
						case 'message_start': {
							if (event.message?.id) messageId = event.message.id
							if (event.message?.usage) {
								yield {
									id: messageId,
									delta: {},
									usage: parseAnthropicUsage(event.message.usage),
								}
							}
							break
						}
						case 'content_block_start': {
							const idx = event.index ?? 0
							const block = event.content_block
							if (block?.type === 'tool_use') {
								activeTools.set(idx, {
									id: block.id ?? `tool-${Date.now()}`,
									name: block.name ?? '',
								})
								yield {
									id: messageId,
									delta: {
										toolCalls: [
											{
												index: idx,
												id: block.id,
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
							// Nothing to emit — aggregation is consumer-side.
							break
						case 'message_delta': {
							if (event.delta?.stop_reason) {
								yield {
									id: messageId,
									delta: {},
									finishReason: mapAnthropicStopReason(event.delta.stop_reason),
									usage: event.usage ? parseAnthropicUsage(event.usage) : undefined,
								}
							} else if (event.usage) {
								yield {
									id: messageId,
									delta: {},
									usage: parseAnthropicUsage(event.usage),
								}
							}
							break
						}
						case 'message_stop':
							return
						case 'error': {
							throw providerVendorError({
								providerId: 'http',
								error: new Error(data),
							})
						}
						default:
							// Unknown / ping events — ignore.
							break
					}
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		// Generic HTTP provider can't assume the endpoint exposes a models list.
		// Callers who know their endpoint shape should query it directly.
		return []
	}

	async healthCheck(): Promise<boolean> {
		try {
			const response = await fetch(this.config.baseURL, {
				method: 'GET',
				headers: this.getHeaders(),
				signal: AbortSignal.timeout(5000),
			})
			return response.ok || response.status === 404 || response.status === 401
		} catch {
			return false
		}
	}
}
