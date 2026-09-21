import type {
	ChatCompletionParams,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import {
	ProviderRequestError,
	isCallerAbortError,
	isProviderRequestError,
	providerHttpError,
	providerVendorError,
} from '@namzu/sdk'
import { attributionHeaders } from '@namzu/sdk'
import type { OpenRouterConfig } from './types.js'

/**
 * Models whose upstream caches only where the request places an explicit
 * `cache_control` breakpoint. OpenRouter's prompt-caching page
 * (openrouter.ai/docs/features/prompt-caching) lists Anthropic Claude, Google
 * Gemini ("only the last breakpoint" is used) and Alibaba Qwen ("requires
 * explicit `cache_control`"); OpenAI, DeepSeek, Grok, Moonshot, Groq and Z.AI
 * cache automatically and are sent no marker, so their messages keep the
 * plain string shape they have always had.
 */
function takesExplicitBreakpoints(model: string): boolean {
	const id = model.replace(/^~/, '').toLowerCase()
	return id.startsWith('anthropic/') || id.startsWith('google/gemini') || id.startsWith('qwen/')
}

/**
 * Request-only context the runtime appends after the conversation: a
 * runtime-context user message of kind `step-context`. It changes from one
 * request to the next, so a breakpoint after it caches a prefix no later
 * request repeats. The same test as the Anthropic driver's.
 */
function isRequestOnlyContext(msg: ChatCompletionParams['messages'][number]): boolean {
	return (
		msg.role === 'user' &&
		msg.source?.type === 'runtime-context' &&
		msg.source.kind === 'step-context'
	)
}

const EPHEMERAL = { type: 'ephemeral' } as const

/**
 * Put a breakpoint on a formatted message's last content part, turning a
 * string into a one-part array to carry it. Answers false when the message
 * has no content to carry one — an assistant turn holding only tool calls.
 *
 * Always INSIDE a content part: a top-level `cache_control` on a `tool`
 * message is not accepted by OpenRouter, while one inside its content part
 * is (NousResearch/hermes-agent#57845, verified against
 * `anthropic/claude-haiku-4.5`).
 */
function markLastPart(message: { content?: unknown }): boolean {
	const content = message.content
	if (typeof content === 'string') {
		if (content.length === 0) return false
		message.content = [{ type: 'text', text: content, cache_control: EPHEMERAL }]
		return true
	}
	if (Array.isArray(content) && content.length > 0) {
		const last = content[content.length - 1]
		if (last === null || typeof last !== 'object') return false
		// A copy: the array is the caller's own message content.
		message.content = [...content.slice(0, -1), { ...last, cache_control: EPHEMERAL }]
		return true
	}
	return false
}

/**
 * Explicit breakpoints for the runtime's cache request: one after the last
 * static system message, one on the last non-system message before
 * request-only context. Two of the four Anthropic allows.
 *
 * This replaces a top-level `cache_control: { type: 'auto' }`. OpenRouter
 * defines the top-level field with `{ type: 'ephemeral' }` only, and applies
 * it "to the last cacheable block" — which, with request-only context at the
 * tail, is the context itself, so the cached prefix would never be read
 * again.
 *
 * System messages are passed over when walking back: the runtime places a
 * step's preamble (host `step.system`, step skills, the policy notice,
 * `turn` contributions) as a system message directly before the context,
 * and its text changes from step to step, so a marker there would end the
 * prefix on bytes the next request does not repeat.
 */
function applyCacheBreakpoints(
	source: ChatCompletionParams['messages'],
	formatted: { content?: unknown }[],
): void {
	let lastStatic = -1
	let historyEnd = source.length
	for (const [i, msg] of source.entries()) {
		if (msg.role === 'system' && msg.cacheHint === 'cache') lastStatic = i
		if (historyEnd === source.length && isRequestOnlyContext(msg)) historyEnd = i
	}
	const staticMessage = lastStatic >= 0 ? formatted[lastStatic] : undefined
	if (staticMessage) markLastPart(staticMessage)
	for (let i = historyEnd - 1; i > lastStatic; i--) {
		if (source[i]?.role === 'system') continue
		const message = formatted[i]
		if (message && markLastPart(message)) return
	}
}

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'

/**
 * A rate OpenRouter published for a model, or nothing.
 *
 * This listing is the one place both answers arrive on the same field and
 * only one of them used to survive. OpenRouter states each rate as a decimal
 * string of USD per token and states `"0"` for the models it serves at no
 * charge — so `?? '0'` did not default a missing price, it asserted one: every
 * model whose pricing block was absent was reported as free, which is a claim
 * about a bill. Absence now stays absent, a published `"0"` is still a real
 * zero, and a value that does not parse is treated as absence rather than
 * `NaN` — which would reach a consumer as a total nobody can read.
 *
 * See `ModelInfo.inputPrice`.
 */
function pricePerMillion(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined
	const parsed = Number.parseFloat(raw)
	return Number.isFinite(parsed) ? parsed * 1_000_000 : undefined
}

interface RawUsage {
	prompt_tokens: number
	completion_tokens: number
	total_tokens: number
	prompt_tokens_details?: {
		cached_tokens?: number
	}
	completion_tokens_details?: {
		reasoning_tokens?: number
	}
	cache_discount?: number
	cache_read_input_tokens?: number
	cache_creation_input_tokens?: number
}

/**
 * The reasoning breakdown, when the vendor reports one.
 *
 * `completion_tokens` already includes these — OpenRouter bills thinking as
 * output — so this is a SUBSET, never an addition. It is reported rather than
 * dropped because it is the only measure of how much of a turn was spent
 * thinking, which is what a reader of `/cost` is looking at when a reasoning
 * model looks expensive. Absent stays absent: a vendor that does not report
 * the split has not reported zero.
 */
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
	const reasoningTokens = raw.completion_tokens_details?.reasoning_tokens
	return {
		promptTokens: raw.prompt_tokens,
		completionTokens: raw.completion_tokens,
		totalTokens: raw.total_tokens,
		cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? 0,
		cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
	}
}

/**
 * One entry of OpenRouter's unified `reasoning_details`.
 *
 * `reasoning.text` and `reasoning.summary` carry visible text; the encrypted
 * form carries an opaque payload this driver must pass through unchanged, or
 * a replaying caller loses the block it paid for.
 */
interface RawReasoningDetail {
	type?: string
	text?: string
	signature?: string
	data?: string
	index?: number
}

type ReasoningDelta = NonNullable<StreamChunk['delta']['reasoning']>

/**
 * Map one frame's reasoning onto the kernel's channel.
 *
 * The wire sends the same text twice: a flat `delta.reasoning` string AND a
 * `delta.reasoning_details` array. Emitting both would double every block, so
 * the array wins whenever it is present — it is the one that carries the index
 * and the signature — and the flat string is the fallback for a vendor that
 * sends only that.
 *
 * An empty array means the frame carried no reasoning at all; it is not a
 * statement that the flat field should be trusted.
 */
function parseReasoning(
	details: readonly RawReasoningDetail[] | undefined,
	flat: string | null | undefined,
): ReasoningDelta[] {
	if (details && details.length > 0) {
		const mapped: ReasoningDelta[] = []
		for (const [position, detail] of details.entries()) {
			const index = typeof detail.index === 'number' ? detail.index : position
			if (detail.type === 'reasoning.encrypted') {
				if (detail.data) mapped.push({ index, type: 'redacted_thinking', encrypted: detail.data })
				continue
			}
			if (typeof detail.text !== 'string' || detail.text.length === 0) continue
			mapped.push({
				index,
				type: 'thinking',
				text: detail.text,
				...(detail.signature ? { signature: detail.signature } : {}),
			})
		}
		return mapped
	}
	return typeof flat === 'string' && flat.length > 0
		? [{ index: 0, type: 'thinking', text: flat }]
		: []
}

/**
 * The effort levels this wire can carry.
 *
 * OpenRouter's unified `reasoning.effort` publishes exactly these. The SDK's
 * `max` and `ultra` are OpenAI-model-specific names with no equivalent here,
 * and a driver must not send one and hope: an effort that arrives as a
 * different depth is indistinguishable from one that was honoured.
 */
const OPENROUTER_REASONING_EFFORT = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

/**
 * Map the SDK's thinking controls onto OpenRouter's unified `reasoning` object.
 *
 * `undefined` means "say nothing", which leaves the vendor's own default in
 * place — the only correct answer for a driver that was asked for nothing.
 */
function formatReasoning(
	thinking: ChatCompletionParams['thinking'],
	effort: ChatCompletionParams['effort'],
): Record<string, unknown> | undefined {
	if (effort !== undefined) {
		const carried = (OPENROUTER_REASONING_EFFORT as readonly string[]).includes(effort)
		if (!carried) {
			throw new Error(
				`OpenRouterProvider cannot carry effort "${effort}". Its reasoning.effort accepts ${OPENROUTER_REASONING_EFFORT.join(', ')}. Sending a different level would return a perfectly ordinary completion that no caller could tell apart from the one that was asked for.`,
			)
		}
		return { effort }
	}
	if (!thinking || thinking.type === undefined) return undefined
	if (thinking.type === 'disabled') return { enabled: false }
	// 'adaptive' has no separate spelling on this wire: the model decides its
	// own depth, which is what `enabled: true` without a budget expresses.
	// 'enabled' fixes the depth with budgetTokens, so it carries the cap.
	const budgetTokens = thinking.type === 'enabled' ? thinking.budgetTokens : undefined
	return {
		enabled: true,
		...(budgetTokens !== undefined ? { max_tokens: budgetTokens } : {}),
	}
}

function formatToolChoice(tc: ToolChoice): unknown {
	if (typeof tc === 'string') return tc
	return tc
}

/**
 * What this DRIVER does, not what OpenRouter could do: tools pass
 * through to the request body, but user-message image `attachments`
 * are not mapped into content parts — `supportsVision` stays false
 * until the message translation handles them.
 */
export const OPENROUTER_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsNativeStructuredOutput: true,
	supportsVision: false,
	// Images only. A document degrades to a named placeholder.
	supportsDocuments: false,
	supportsToolResultImages: false,
	supportsToolResultDocuments: false,
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
			// First, so anything a host sets below still wins. Attribution is
			// what this kernel says about itself; a host overriding it has a
			// reason and is not to be argued with.
			...attributionHeaders(),
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

		if (params.cacheControl && takesExplicitBreakpoints(params.model)) {
			applyCacheBreakpoints(params.messages, body.messages as { content?: unknown }[])
		}

		// Refused, not dropped, when this wire cannot carry the level asked
		// for — see `formatReasoning`.
		const reasoning = formatReasoning(params.thinking, params.effort)
		if (reasoning !== undefined) {
			body.reasoning = reasoning
		}

		if (params.responseFormat) {
			body.response_format = params.responseFormat
		}

		return body
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const body = this.buildRequestBody(params, true)

		const timeout = AbortSignal.timeout(this.config.timeout ?? 120_000)
		// Compose the caller abort with the request timeout so a Stop cancels the
		// response body stream. When no caller signal is present this is the exact
		// prior `AbortSignal.timeout(...)` expression (byte-identical).
		const signal = params.signal ? AbortSignal.any([timeout, params.signal]) : timeout

		let response: Response
		try {
			response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: this.getHeaders(),
				body: JSON.stringify(body),
				signal,
			})
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			throw providerVendorError({ providerId: 'openrouter', error: err })
		}

		if (!response.ok) {
			// The body is read to CLASSIFY (a 400 saying "prompt is too long" is a
			// context overflow, any other 400 is a bad request) and then dropped. It
			// used to be interpolated straight into the message, which is how a
			// credential the upstream echoed back reached every log that recorded
			// the failure — proven with a planted fake token.
			const errorBody = await response.text().catch(() => '')
			throw providerHttpError({
				providerId: 'openrouter',
				status: response.status,
				body: errorBody,
				retryAfter: response.headers.get('retry-after'),
			})
		}

		if (!response.body) {
			throw new ProviderRequestError({
				kind: 'server',
				providerId: 'openrouter',
				status: response.status,
				detail: 'the response contained no stream body',
			})
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		// Reasoning blocks this stream has opened and not yet closed, in the
		// order the wire reported them.
		const openReasoning = new Set<number>()

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
							error?: unknown
							choices: Array<{
								delta: {
									content?: string
									reasoning?: string | null
									reasoning_details?: RawReasoningDetail[]
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

						if (parsed.error !== undefined) {
							throw providerVendorError({
								providerId: 'openrouter',
								error: new Error(data),
							})
						}

						const choice = parsed.choices[0]
						if (!choice) continue

						const fragments = parseReasoning(choice.delta.reasoning_details, choice.delta.reasoning)
						const content = choice.delta.content
						const toolCalls = choice.delta.tool_calls?.map((tc) => ({
							index: tc.index,
							id: tc.id,
							type: tc.type as 'function' | undefined,
							function: tc.function,
						}))

						// A block closes when output starts, which is the only boundary
						// this wire gives: without it a consumer's reasoning pane never
						// receives `done` and stays open for the life of the run. An
						// empty `content` is NOT output — every reasoning frame on this
						// wire carries `"content":""`, so treating it as the boundary
						// would close each block on the frame that opened it.
						if ((typeof content === 'string' && content.length > 0) || toolCalls?.length) {
							for (const index of openReasoning) {
								yield { id: parsed.id, delta: { reasoning: { index, done: true } } }
							}
							openReasoning.clear()
						}

						const [firstFragment, ...restFragments] = fragments
						if (firstFragment) openReasoning.add(firstFragment.index)

						if (
							firstFragment ||
							content !== undefined ||
							toolCalls !== undefined ||
							choice.finish_reason !== undefined ||
							parsed.usage !== undefined
						) {
							yield {
								id: parsed.id,
								delta: {
									...(firstFragment ? { reasoning: firstFragment } : {}),
									content,
									toolCalls,
								},
								finishReason: choice.finish_reason as StreamChunk['finishReason'],
								usage: parsed.usage ? parseUsage(parsed.usage) : undefined,
							}
						}

						// The delta shape carries one reasoning object per chunk, so a
						// frame reporting several blocks rides in sequence rather than
						// being collapsed into one — order is what replay echoes back.
						for (const fragment of restFragments) {
							openReasoning.add(fragment.index)
							yield { id: parsed.id, delta: { reasoning: fragment } }
						}
					} catch (parseErr) {
						if (isProviderRequestError(parseErr)) throw parseErr
						// JSON SyntaxError messages include a source snippet, and
						// mapping failures may include vendor values. Drop both.
						throw new ProviderRequestError({
							kind: 'server',
							providerId: 'openrouter',
							detail: 'the provider stream returned malformed data',
						})
					}
				}
			}
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'openrouter', error: err })
		} finally {
			reader.releaseLock()
		}
	}

	/**
	 * Ask about the KEY, not about the catalogue.
	 *
	 * `listModels` here is already honest — it has no fallback and returns
	 * exactly what the server sent. It is still useless as a credential check,
	 * because `/models` does not authenticate: any string whatsoever, including
	 * a typo or a revoked key, came back with the full catalogue and was
	 * reported as verified. Nothing was wrong with the menu; the menu was simply
	 * never evidence about the key.
	 *
	 * `/key` is the endpoint that answers the question actually being asked. It
	 * requires the credential and returns its metadata, so a 401 here means the
	 * key is genuinely refused.
	 */
	async probeCredential(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted()
		const response = await fetch(`${this.baseUrl}/key`, {
			headers: this.getHeaders(),
			...(signal ? { signal } : {}),
		})
		signal?.throwIfAborted()
		if (!response.ok) {
			const err = new Error(`Credential check failed: ${response.status}`) as Error & {
				status?: number
			}
			err.status = response.status
			throw err
		}
	}

	/**
	 * The vendor's own `context_length` for this model.
	 *
	 * This driver already parsed the number and threw it away: `listModels`
	 * maps it into `contextWindow` and nothing downstream ever asked. The
	 * kernel meanwhile fell back to a hand-maintained prefix table whose own
	 * header records what that costs — every Claude entry carried 200k
	 * including the 1M-window models, so those runs compacted at roughly 14%
	 * full. OpenRouter fronts hundreds of models from a dozen vendors, so it
	 * is the driver where a static table drifts fastest.
	 *
	 * `undefined` for a model the listing does not contain, rather than a
	 * guess: "I asked and it is not there" leaves the table exactly as
	 * authoritative as it was, while a substituted number would present a
	 * guess as a vendor answer.
	 *
	 * A fulfilled listing is cached for this driver, because a payload of
	 * several hundred models does not change under a running run. Pending
	 * requests stay caller-owned, so concurrent cold misses may duplicate the
	 * request rather than letting one caller's cancellation own both. A
	 * failure is NOT cached — the next run asks again rather than inheriting
	 * one bad minute forever.
	 */
	async resolveContextWindow(model: string, signal?: AbortSignal): Promise<number | undefined> {
		if (signal?.aborted) return undefined
		let windows = this.contextWindows
		if (!windows) {
			const models = await this.listModels(signal)
			if (signal?.aborted) return undefined
			windows = new Map<string, number>(
				models
					.filter(
						(m): m is typeof m & { contextWindow: number } => typeof m.contextWindow === 'number',
					)
					.map((m) => [m.id, m.contextWindow]),
			)
			// Cache only a fulfilled value. Sharing a pending request would make
			// its first caller's AbortSignal the owner of every concurrent query's
			// metadata transport; cancelling that caller would then degrade still-
			// authorized runs to the static table. Concurrent cold misses may issue
			// duplicate listings, and converge here after either succeeds.
			this.contextWindows ??= windows
			windows = this.contextWindows
		}
		const reported = windows.get(model)
		return typeof reported === 'number' && reported > 0 ? reported : undefined
	}

	/** First fulfilled listing; see the note on `resolveContextWindow`. */
	private contextWindows?: Map<string, number>

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		signal?.throwIfAborted()
		const response = await fetch(`${this.baseUrl}/models`, {
			headers: this.getHeaders(),
			...(signal ? { signal } : {}),
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
		signal?.throwIfAborted()

		return data.data.map((m) => {
			const inputPrice = pricePerMillion(m.pricing?.prompt)
			const outputPrice = pricePerMillion(m.pricing?.completion)
			return {
				id: m.id,
				name: m.name,
				contextWindow: m.context_length,
				maxOutputTokens: m.top_provider?.max_completion_tokens ?? 4096,
				...(inputPrice !== undefined ? { inputPrice } : {}),
				...(outputPrice !== undefined ? { outputPrice } : {}),
				supportsToolUse: true,
				supportsStreaming: true,
			}
		})
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
