import { execFileSync } from 'node:child_process'
import Anthropic from '@anthropic-ai/sdk'
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
import type { AnthropicConfig } from './types.js'

// Floor for `max_tokens` when neither the request nor the provider
// config supplied one. Anthropic's API requires the field, so we cannot
// truly omit it — but 4096 (the original SDK example default) is far
// below what Sonnet 4.6 / Opus 4.7 natively emit, and would silently
// clip 20k-word documents. 64k is the canonical "long output" budget
// these models advertise; the model still stops at its own native
// ceiling, so passing 64k just means "don't bound below the model".
const DEFAULT_MAX_TOKENS = 64_000
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 0

// Claude Code OAuth tokens are scoped to Claude Code usage. Anthropic
// authorizes them only when three signals are all present, else 401:
//   1. the OAuth beta headers,
//   2. a `claude-cli/<version>` user-agent (version validated server-side),
//   3. a system prompt whose first block is the Claude Code identity line.
const OAUTH_BETAS = 'claude-code-20250219,oauth-2025-04-20'
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."
const CLAUDE_CODE_VERSION_FALLBACK = '2.1.74'

let claudeCodeVersionCache: string | null = null
function detectClaudeCodeVersion(): string {
	if (claudeCodeVersionCache !== null) return claudeCodeVersionCache
	for (const bin of ['claude', 'claude-code']) {
		try {
			const out = execFileSync(bin, ['--version'], {
				encoding: 'utf8',
				timeout: 5_000,
				stdio: ['ignore', 'pipe', 'ignore'],
			})
				.trim()
				.split(/\s+/)[0]
			if (out && /^\d/.test(out)) {
				claudeCodeVersionCache = out
				return out
			}
		} catch {
			// try next binary
		}
	}
	claudeCodeVersionCache = CLAUDE_CODE_VERSION_FALLBACK
	return CLAUDE_CODE_VERSION_FALLBACK
}

// --------------------------------------------------------------------------------------
// Message translation: @namzu/sdk → Anthropic Messages API
// --------------------------------------------------------------------------------------

/**
 * Anthropic prompt-cache breakpoint marker. A `cache_control` on a block
 * caches everything up to and including that block in the fixed render
 * order tools → system → messages (max 4 breakpoints per request).
 */
interface AnthropicCacheControl {
	type: 'ephemeral'
}

interface AnthropicTextBlock {
	type: 'text'
	text: string
	cache_control?: AnthropicCacheControl
}

interface AnthropicToolUseBlock {
	type: 'tool_use'
	id: string
	name: string
	input: unknown
	cache_control?: AnthropicCacheControl
}

interface AnthropicToolResultBlock {
	type: 'tool_result'
	tool_use_id: string
	/**
	 * Anthropic accepts a string OR an array of text/image blocks here.
	 * namzu only ever sent a string, which is why a `computer-use`
	 * screenshot reached the model as base64 TEXT.
	 */
	content: string | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock>
	/**
	 * Anthropic prescribes `is_error: true` so the model recognises a
	 * failure and retries. namzu computed this and then dropped it at the
	 * provider boundary, leaving prose formatting to convey failure.
	 */
	is_error?: boolean
	cache_control?: AnthropicCacheControl
}

interface AnthropicDocumentBlock {
	type: 'document'
	source: { type: 'base64'; media_type: string; data: string }
	title?: string
	cache_control?: AnthropicCacheControl
}

/**
 * Extended-thinking blocks. Opaque to namzu: parsed, stored and replayed
 * verbatim, never interpreted. The signature is load-bearing — Anthropic
 * requires the preceding assistant turn to be echoed back unchanged when a
 * `tool_result` follows, and a rebuilt turn triggers ordering/signature
 * errors.
 */
interface AnthropicThinkingBlock {
	type: 'thinking'
	thinking: string
	signature?: string
	cache_control?: AnthropicCacheControl
}

interface AnthropicRedactedThinkingBlock {
	type: 'redacted_thinking'
	data: string
	cache_control?: AnthropicCacheControl
}

interface AnthropicImageBlock {
	type: 'image'
	source: { type: 'base64'; media_type: string; data: string }
	cache_control?: AnthropicCacheControl
}

interface AnthropicToolParam {
	name: string
	description: string
	input_schema: unknown
	cache_control?: AnthropicCacheControl
}

/** Shape of an SDK `ImageAttachment` (read structurally to avoid coupling). */
interface AttachmentLike {
	readonly data: string
	readonly mediaType: string
}

type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock
	| AnthropicImageBlock
	| AnthropicDocumentBlock
	| AnthropicThinkingBlock
	| AnthropicRedactedThinkingBlock

interface AnthropicMessageParam {
	role: 'user' | 'assistant'
	content: string | AnthropicContentBlock[]
}

/**
 * System messages become a block array (one block per SystemMessage) so the
 * runtime's `cacheHint` segment boundaries survive into the request: the
 * PromptBuilder tags the static segment `'cache'` and the per-run dynamic
 * segment `'ephemeral'`. When caching is enabled, the LAST `'cache'`-tagged
 * block carries the `cache_control` breakpoint — everything up to it
 * (tools + static system) is cached; dynamic blocks after it are not.
 */
function extractSystem(
	messages: ChatCompletionParams['messages'],
	cachingEnabled: boolean,
): AnthropicTextBlock[] | undefined {
	const blocks: AnthropicTextBlock[] = []
	let lastCacheTagged: AnthropicTextBlock | undefined
	for (const msg of messages) {
		if (msg.role === 'system' && typeof msg.content === 'string' && msg.content.length > 0) {
			const block: AnthropicTextBlock = { type: 'text', text: msg.content }
			blocks.push(block)
			if (msg.cacheHint === 'cache') lastCacheTagged = block
		}
	}
	if (blocks.length === 0) return undefined
	if (cachingEnabled && lastCacheTagged) {
		lastCacheTagged.cache_control = { type: 'ephemeral' }
	}
	return blocks
}

/** Exported for the wire-shape tests; not part of the package surface. */
export function toAnthropicMessages(
	messages: ChatCompletionParams['messages'],
): AnthropicMessageParam[] {
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
			const toolMsg = msg as { toolCallId?: string; content?: unknown; isError?: boolean }
			pendingToolResults.push({
				type: 'tool_result',
				tool_use_id: toolMsg.toolCallId ?? 'unknown',
				content: toAnthropicToolResultContent(toolMsg.content),
				// Anthropic prescribes this so the model recognises the
				// failure and retries; the runtime has always known it and
				// used to discard it exactly here.
				...(toolMsg.isError === true ? { is_error: true } : {}),
			})
			continue
		}

		flushToolResults()

		if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
			const blocks: AnthropicContentBlock[] = []
			// Thinking blocks FIRST, verbatim, signature intact. Anthropic
			// requires the assistant turn preceding a `tool_result` to be
			// echoed back unchanged; rebuilding it as `[text, ...tool_use]`
			// — which is what this function used to do unconditionally — is
			// precisely the pattern that contract prohibits, and produces
			// ordering/signature errors once extended thinking is on.
			for (const block of readReasoning(msg)) {
				if (block.type === 'redacted_thinking') {
					if (block.encrypted) blocks.push({ type: 'redacted_thinking', data: block.encrypted })
					continue
				}
				blocks.push({
					type: 'thinking',
					thinking: block.text ?? '',
					...(block.signature ? { signature: block.signature } : {}),
				})
			}
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
		// User message with image attachments → multimodal content blocks
		// (text first, then each image as a base64 image block).
		const attachments = (msg as { attachments?: readonly AttachmentLike[] }).attachments
		if (msg.role === 'user' && attachments && attachments.length > 0) {
			const blocks: AnthropicContentBlock[] = []
			if (content.length > 0) blocks.push({ type: 'text', text: content })
			for (const att of attachments) {
				blocks.push({
					type: 'image',
					source: { type: 'base64', media_type: att.mediaType, data: att.data },
				})
			}
			out.push({ role: 'user', content: blocks })
			continue
		}
		out.push({
			role: msg.role === 'assistant' ? 'assistant' : 'user',
			content,
		})
	}

	flushToolResults()
	return out
}

function toAnthropicTools(
	params: ChatCompletionParams,
	cachingEnabled: boolean,
): AnthropicToolParam[] | undefined {
	if (!params.tools || params.tools.length === 0) return undefined
	const tools: AnthropicToolParam[] = params.tools.map((t) => ({
		name: t.function.name,
		description: t.function.description ?? '',
		input_schema: t.function.parameters ?? { type: 'object' },
	}))
	if (cachingEnabled) {
		// Breakpoint on the tools-array tail: tools render at position 0 of
		// the cache prefix, so this caches every tool schema even when the
		// system/message breakpoints downstream get invalidated.
		const tail = tools[tools.length - 1]
		if (tail) tail.cache_control = { type: 'ephemeral' }
	}
	return tools
}

function toAnthropicToolChoice(tc?: ToolChoice, parallelToolCalls?: boolean): unknown {
	// Anthropic expresses "no parallel tool calls" as a field ON tool_choice,
	// not a top-level param. Only auto/any/tool accept it ('none' fires no
	// tools, so the field is meaningless there).
	const disable = parallelToolCalls === false ? { disable_parallel_tool_use: true } : undefined
	if (tc === undefined) {
		return disable ? { type: 'auto', ...disable } : undefined
	}
	if (tc === 'auto') return { type: 'auto', ...disable }
	if (tc === 'required') return { type: 'any', ...disable }
	// 'none' is first-class on the Messages API ("prevents Claude from using
	// any tools"). Mapping it this way — instead of omitting the tools param —
	// keeps the tools+system cache prefix intact and avoids a 400 when the
	// conversation history still carries tool_use/tool_result blocks.
	if (tc === 'none') return { type: 'none' }
	if (typeof tc === 'object' && tc.type === 'function') {
		return { type: 'tool', name: tc.function.name, ...disable }
	}
	return undefined
}

/**
 * Final cache breakpoint: the last content block of the last non-empty
 * message. Caches the whole conversation prefix so the next iteration
 * (which only appends messages) reads the prior history at cache rates.
 */
function applyMessageCacheBreakpoint(messages: AnthropicMessageParam[]): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (!msg) continue
		if (typeof msg.content === 'string') {
			if (msg.content.length === 0) continue
			msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }]
			return
		}
		if (msg.content.length > 0) {
			const last = msg.content[msg.content.length - 1]
			if (last) last.cache_control = { type: 'ephemeral' }
			return
		}
	}
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
	content_block?: { type?: string; id?: string; name?: string; data?: string }
	delta?: {
		type?: string
		text?: string
		partial_json?: string
		stop_reason?: string | null
		/** `thinking_delta` payload. */
		thinking?: string
		/** `signature_delta` payload — must be replayed verbatim. */
		signature?: string
		/** `redacted_thinking` opaque payload. */
		data?: string
	}
	usage?: RawAnthropicUsage
}

// --------------------------------------------------------------------------------------
// AnthropicProvider
// --------------------------------------------------------------------------------------

/**
 * Full capability set — this driver maps tools (`toAnthropicTools`),
 * streams natively, and maps user-message image `attachments` into
 * base64 image content blocks (`toAnthropicMessages`).
 */
export const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
}

export class AnthropicProvider implements LLMProvider {
	readonly id = 'anthropic'
	readonly name = 'Anthropic'
	readonly capabilities = ANTHROPIC_CAPABILITIES

	private client: Anthropic
	private config: AnthropicConfig

	constructor(config: AnthropicConfig) {
		if (!config.apiKey && !config.authToken) {
			throw new Error('AnthropicProvider: either `apiKey` or `authToken` is required')
		}
		this.config = config

		const clientOpts: Record<string, unknown> = {
			timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
		}
		if (config.authToken) {
			clientOpts.authToken = config.authToken
			// OAuth routes require both beta flags + a Claude Code user-agent;
			// without them Anthropic rejects subscription / Claude Code OAuth
			// tokens (intermittent 401/500). The system-prompt identity block
			// is added per-request in buildCreateParams.
			const headers: Record<string, string> = {
				'anthropic-beta': OAUTH_BETAS,
				'user-agent': `claude-cli/${detectClaudeCodeVersion()} (external, cli)`,
				...(config.defaultHeaders ?? {}),
			}
			clientOpts.defaultHeaders = headers
		} else {
			clientOpts.apiKey = config.apiKey
			if (config.defaultHeaders) clientOpts.defaultHeaders = config.defaultHeaders
		}
		if (config.baseURL) clientOpts.baseURL = config.baseURL

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
		// The runtime requests caching via `params.cacheControl` on every
		// iteration. Honoring it costs three of the four allowed breakpoints:
		// tools tail + static-system tail + last message block (render order
		// is tools → system → messages, so each later breakpoint covers all
		// earlier sections too).
		const cachingEnabled = params.cacheControl !== undefined
		const system = extractSystem(params.messages, cachingEnabled)
		const messages = toAnthropicMessages(params.messages)
		if (cachingEnabled) applyMessageCacheBreakpoint(messages)
		const tools = toAnthropicTools(params, cachingEnabled)
		const toolChoice = toAnthropicToolChoice(params.toolChoice, params.parallelToolCalls)

		const body: Record<string, unknown> = {
			model: this.resolveModel(params),
			messages,
			max_tokens: params.maxTokens ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
			stream,
		}

		if (this.config.authToken) {
			// OAuth: the first system block must be the Claude Code identity
			// line or Anthropic rejects the request. Emit the block-array form
			// with the identity prefix first; cache breakpoints (if any) stay
			// on the tagged blocks behind it, so the ordering survives.
			const ccBlock: AnthropicTextBlock = { type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX }
			body.system = system ? [ccBlock, ...system] : [ccBlock]
		} else if (system) {
			body.system = system
		}
		if (tools) body.tools = tools
		// tool_choice is only legal alongside tools (the API rejects it
		// otherwise) — this also drops a parallelToolCalls-derived choice on
		// tool-less requests.
		if (tools && toolChoice) body.tool_choice = toolChoice
		if (params.thinking) {
			// Anthropic rejects `temperature`, `top_p` and `top_k` while
			// thinking is enabled, so they are omitted rather than passed and
			// 400'd — the request the caller wanted is the one with thinking.
			body.thinking =
				params.thinking.type === 'enabled'
					? {
							type: 'enabled',
							...(params.thinking.budgetTokens !== undefined
								? { budget_tokens: params.thinking.budgetTokens }
								: {}),
						}
					: { type: 'disabled' }
		}
		if (!params.thinking || params.thinking.type === 'disabled') {
			if (params.temperature !== undefined) body.temperature = params.temperature
			if (params.topP !== undefined) body.top_p = params.topP
			if (params.topK !== undefined) body.top_k = params.topK
		}
		if (params.stop) body.stop_sequences = params.stop

		return body
	}

	/**
	 * The SDK's `messages.create` is overloaded on the `stream` flag. We build
	 * the request as an untyped object bag and narrow the response shape ourselves.
	 * Casting via `unknown` keeps us out of `any` territory while acknowledging
	 * that the translation layer bridges two type worlds.
	 */
	private createRaw(
		body: Record<string, unknown>,
		opts?: { signal?: AbortSignal },
	): Promise<unknown> {
		const create = this.client.messages.create as unknown as (
			body: Record<string, unknown>,
			options?: { signal?: AbortSignal },
		) => Promise<unknown>
		// Pass the caller AbortSignal as the SDK's per-request RequestOptions so
		// aborting it tears down the in-flight HTTP/2 SSE request (rejects with
		// APIUserAbortError). A non-aborted signal is identical to omitting it.
		return create.call(this.client.messages, body, { signal: opts?.signal })
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const createParams = this.buildCreateParams(params, true)
		const signal = params.signal

		const stream = (await this.createRaw(createParams, { signal })) as AsyncIterable<StreamEvent>

		let messageId = ''
		// Track active tool-use blocks by content_block index so input_json_delta
		// fragments can reference the right tool call.
		const activeTools = new Map<number, { id: string; name: string }>()

		// Reasoning block indices still open, so `content_block_stop` knows

		// whether it is closing a tool or a thinking block.

		const openReasoning = new Set<number>()

		// Anthropic Messages API streams over SSE. Do not impose a
		// provider-local 90s idle cutoff by default: long reasoning or
		// long tool-argument generation can legitimately pause between
		// SSE events, and cutting it here turns a healthy Messages API
		// run into a false "tool input truncated" failure. Deployments
		// that still need a per-event watchdog can opt in via
		// `streamIdleTimeoutMs`; otherwise the request timeout and caller
		// AbortSignal own lifecycle cancellation.
		const streamIdleTimeoutMs = this.config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
		const iter = (stream as AsyncIterable<StreamEvent>)[Symbol.asyncIterator]()
		const nextWithIdleTimeout = async (): Promise<IteratorResult<StreamEvent>> => {
			if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
				return iter.next()
			}
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				return await Promise.race([
					iter.next(),
					new Promise<IteratorResult<StreamEvent>>((_, reject) => {
						timer = setTimeout(() => {
							reject(
								new Error(
									`Anthropic stream idle for ${Math.round(streamIdleTimeoutMs / 1000)}s — aborting so the run lifecycle can emit run_failed.`,
								),
							)
						}, streamIdleTimeoutMs)
					}),
				])
			} finally {
				if (timer !== undefined) clearTimeout(timer)
			}
		}

		try {
			for (;;) {
				// Cheap between-chunk abort check: if a Stop fired, stop pulling
				// (the runtime also races this, and the SDK request is aborted).
				signal?.throwIfAborted()
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
							// Thinking blocks used to fall through to
							// `default: // ignore`, so they were neither surfaced nor
							// storable — which is what made the verbatim-echo contract
							// unsatisfiable and left the streaming UI with a silent
							// multi-second gap while the model was demonstrably working.
							if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
								// Register the block so its close is recognised. Without
								// this the set stayed empty, the `content_block_stop`
								// branch below could never match, and `done: true` was
								// never emitted — so a UI that opened a thinking card
								// left it spinning for the rest of the run.
								openReasoning.add(idx)
								yield {
									id: messageId,
									delta: {
										reasoning: {
											index: idx,
											type: block.type,
											...(block.data ? { encrypted: block.data } : {}),
										},
									},
								}
								break
							}
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
							} else if (delta?.type === 'thinking_delta' && delta.thinking) {
								yield { id: messageId, delta: { reasoning: { index: idx, text: delta.thinking } } }
							} else if (delta?.type === 'signature_delta' && delta.signature) {
								// The signature arrives once, at the end of the block, and
								// replaying it unchanged is what keeps the echo valid.
								yield {
									id: messageId,
									delta: { reasoning: { index: idx, signature: delta.signature } },
								}
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
							// — exactly the failure the live supervised-run test
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
								break
							}
							// A reasoning block closes here too; the consumer needs the
							// boundary to emit `reasoning_completed` rather than waiting
							// for end-of-stream.
							if (openReasoning.has(idx)) {
								openReasoning.delete(idx)
								yield { id: messageId, delta: { reasoning: { index: idx, done: true } } }
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
			// gap called out in review.
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

/** Shape of an SDK `ReasoningBlock`, read structurally to avoid coupling. */
interface ReasoningBlockLike {
	readonly type: 'thinking' | 'redacted_thinking'
	readonly text?: string
	readonly signature?: string
	readonly encrypted?: string
}

function readReasoning(msg: unknown): readonly ReasoningBlockLike[] {
	const blocks = (msg as { reasoning?: readonly ReasoningBlockLike[] } | null)?.reasoning
	return Array.isArray(blocks) ? blocks : []
}

/**
 * Map namzu tool-result content onto Anthropic's `tool_result.content`.
 *
 * A plain string stays a plain string — the common case, and the shape
 * that keeps the cache prefix byte-identical for every existing run.
 * Blocks become Anthropic blocks, which is what makes a screenshot
 * actually reach the model instead of arriving as base64 text.
 */
function toAnthropicToolResultContent(
	content: unknown,
): string | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock> {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return JSON.stringify(content)

	const blocks: Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock> = []
	for (const block of content as readonly Record<string, unknown>[]) {
		switch (block.type) {
			case 'text':
				blocks.push({ type: 'text', text: String(block.text ?? '') })
				break
			case 'image':
				blocks.push({
					type: 'image',
					source: {
						type: 'base64',
						media_type: String(block.mediaType),
						data: String(block.data),
					},
				})
				break
			case 'document':
				blocks.push({
					type: 'document',
					source: {
						type: 'base64',
						media_type: String(block.mediaType),
						data: String(block.data),
					},
					...(block.name ? { title: String(block.name) } : {}),
				})
				break
		}
	}
	// Anthropic rejects an empty content array; a result that reduced to
	// nothing still has to say something.
	return blocks.length > 0 ? blocks : '(no content)'
}
