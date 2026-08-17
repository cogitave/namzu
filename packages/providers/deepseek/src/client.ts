import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	ReasoningBlock,
	StreamChunk,
	ThinkingConfig,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import {
	ProviderRequestError,
	attributionHeaders,
	isCallerAbortError,
	isProviderRequestError,
	providerVendorError,
	toolResultToText,
} from '@namzu/sdk'
import OpenAI from 'openai'
import type {
	ChatCompletionMessageParam,
	ChatCompletionTool,
	ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions'
import type { DeepSeekConfig } from './types.js'

/**
 * No vision, no documents.
 *
 * The wire is OpenAI's Chat Completions, which has `image_url` content parts —
 * but the models behind this endpoint are text-only, and a capability set is a
 * claim about what a call will actually do, not about what the request format
 * can express. Claiming vision here would route an image-bearing run to a
 * driver that sends the image and gets prose about nothing.
 */
export const DEEPSEEK_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: false,
	supportsDocuments: false,
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'

type DeepSeekFinishReason =
	| 'stop'
	| 'length'
	| 'tool_calls'
	| 'content_filter'
	| 'insufficient_system_resource'

function mapFinishReason(
	reason: DeepSeekFinishReason | string | null | undefined,
): ChatCompletionResponse['finishReason'] {
	switch (reason) {
		case 'length':
			return 'length'
		case 'tool_calls':
			return 'tool_calls'
		case 'content_filter':
			return 'content_filter'
		default:
			return 'stop'
	}
}

/**
 * Usage, including the two counts this vendor reports that OpenAI's shape does
 * not.
 *
 * `completion_tokens_details.reasoning_tokens` is billed as output and is not
 * separable from it after the fact, so it is surfaced rather than discarded —
 * a thinking-mode run whose reasoning dwarfs its answer looks like an
 * inexplicably expensive short reply otherwise.
 *
 * `prompt_cache_hit_tokens` is the vendor's own name for what
 * `prompt_tokens_details.cached_tokens` also reports. Both are read, the
 * details field first, because the flat one is the older spelling and a
 * gateway may forward only one.
 */
interface RawDeepSeekUsage {
	prompt_tokens?: number
	completion_tokens?: number
	total_tokens?: number
	prompt_tokens_details?: { cached_tokens?: number }
	prompt_cache_hit_tokens?: number
	completion_tokens_details?: { reasoning_tokens?: number }
}

function parseUsage(raw?: RawDeepSeekUsage | null): TokenUsage {
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
	const reasoningTokens = raw.completion_tokens_details?.reasoning_tokens
	return {
		promptTokens,
		completionTokens,
		totalTokens: raw.total_tokens ?? promptTokens + completionTokens,
		cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0,
		// The vendor has no write-side cache charge: a cache entry is created as
		// a side effect of a miss, at the ordinary input rate. Reporting a
		// fabricated number here would be worse than the zero.
		cacheWriteTokens: 0,
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
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

/** The four the vendor accepts in thinking mode and applies none of. */
const SAMPLING_FIELDS = ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty'] as const

/**
 * Is thinking on for this call?
 *
 * **Absent means ON.** That is the vendor's default, not a guess: a request
 * with no `thinking` key comes back carrying `reasoning_content`. Every rule
 * below that turns on "thinking is enabled" has to read it this way, or it
 * applies to explicit callers only and misses the common case entirely.
 */
export function thinkingEnabled(thinking: ThinkingConfig | undefined): boolean {
	return thinking?.type !== 'disabled'
}

/**
 * Refuse a sampling parameter that thinking mode will discard.
 *
 * Measured against the live API on 2026-08-17 rather than read off the
 * documentation, which says only that these are "not supported": all four are
 * accepted with HTTP 200 and applied to nothing. So a caller who pinned
 * `temperature: 0` for reproducibility gets sampling, no error, and no way to
 * find out — `refuse-do-not-degrade`, exactly.
 *
 * `samplingInThinkingMode: 'ignore'` opts out, for a host that keeps one
 * parameter set across several providers and would rather this one drop them
 * quietly than make it special.
 */
export function assertSamplingUsable(
	params: ChatCompletionParams,
	mode: 'refuse' | 'ignore',
): void {
	if (mode === 'ignore') return
	if (!thinkingEnabled(params.thinking)) return
	const set = SAMPLING_FIELDS.filter((f) => params[f] !== undefined)
	if (set.length === 0) return
	throw new Error(
		`DeepSeekProvider: ${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} ignored in thinking mode, which is on for this call — the vendor accepts them and applies none of them, so the call would silently sample when you asked it not to. Disable thinking for this call (\`thinking: { type: 'disabled' }\`) to have them honoured, drop them, or set \`samplingInThinkingMode: 'ignore'\` on the provider to send them anyway.`,
	)
}

/**
 * Refuse a reasoning effort this wire cannot carry.
 *
 * `thinking.effort` is accepted here and validated against nothing — measured:
 * `effort: 'bogus'` returns 200, and `effort: 'none'` still produces reasoning
 * tokens. Only `thinking.type` is validated (the vendor's own error names its
 * variants: `adaptive`, `enabled`, `disabled`). So an effort sent on this wire
 * is a parameter accepted and discarded, which is the one thing a driver must
 * not do quietly.
 *
 * The vendor's Anthropic-format endpoint does take `reasoning.effort`. A
 * driver built on that wire could honour this; this one is built on Chat
 * Completions and says so.
 */
export function assertEffortUnsupported(params: ChatCompletionParams): void {
	if (params.effort === undefined) return
	throw new Error(
		`DeepSeekProvider: \`effort\` is not carried by this endpoint. The vendor's Chat Completions wire validates \`thinking.type\` and ignores any effort sent beside it, so passing one through would change nothing and report success. Use \`thinking: { type: 'adaptive' | 'enabled' | 'disabled' }\` to steer this driver.`,
	)
}

/**
 * The reasoning blocks an assistant message carries, in wire form.
 *
 * The vendor's rule: with tool calls in play, an assistant turn's
 * `reasoning_content` **must** be replayed in every later turn of the same
 * flow; without tool calls it is ignored if sent. Replayed unconditionally
 * here, which satisfies both halves and matches what `AssistantMessage.reasoning`
 * already promises — "replayed verbatim and ahead of the text/tool blocks".
 *
 * Measured note, because it matters to anyone debugging this: as of
 * 2026-08-17 omitting the replay does NOT produce the documented 400 on either
 * `deepseek-v4-flash` or `deepseek-v4-pro`. The rule is still followed, because
 * a contract the vendor states and does not currently enforce is a contract
 * that can start being enforced in any release.
 */
function replayReasoning(reasoning: readonly ReasoningBlock[] | undefined): string | undefined {
	if (!reasoning || reasoning.length === 0) return undefined
	const text = reasoning
		.filter((b) => b.type === 'thinking' && typeof b.text === 'string')
		.map((b) => b.text as string)
		.join('')
	return text.length > 0 ? text : undefined
}

export function toDeepSeekMessages(
	messages: ChatCompletionParams['messages'],
): ChatCompletionMessageParam[] {
	return messages.map((msg): ChatCompletionMessageParam => {
		if (msg.role === 'system') return { role: 'system', content: msg.content }
		if (msg.role === 'user') {
			// No attachment branch, deliberately. `DEEPSEEK_CAPABILITIES` says
			// this driver has neither vision nor documents, and a driver that
			// quietly encoded an image the model cannot read would answer about
			// a picture it never saw.
			if (msg.attachments && msg.attachments.length > 0) {
				throw new Error(
					'DeepSeekProvider: this driver has no vision or document support, and a message carried attachments. Route multimodal turns to a provider whose capabilities include them.',
				)
			}
			return { role: 'user', content: msg.content }
		}
		if (msg.role === 'tool') {
			return {
				role: 'tool',
				content: toolResultToText(msg.content),
				tool_call_id: msg.toolCallId,
			}
		}
		const assistant: ChatCompletionMessageParam = { role: 'assistant', content: msg.content }
		if ('toolCalls' in msg && msg.toolCalls && msg.toolCalls.length > 0) {
			;(assistant as { tool_calls?: unknown }).tool_calls = msg.toolCalls.map((tc) => ({
				id: tc.id,
				type: 'function' as const,
				function: { name: tc.function.name, arguments: tc.function.arguments },
			}))
		}
		const replayed = replayReasoning((msg as { reasoning?: readonly ReasoningBlock[] }).reasoning)
		if (replayed !== undefined) {
			;(assistant as { reasoning_content?: string }).reasoning_content = replayed
		}
		return assistant
	})
}

export function toDeepSeekTools(params: ChatCompletionParams): ChatCompletionTool[] | undefined {
	if (!params.tools || params.tools.length === 0) return undefined
	// No `strict` branch: `enforceToolInputSchema` names tools whose schema
	// should be enforced rather than suggested, and this wire has no field for
	// it. Setting `strict: true` here would be accepted and ignored — the same
	// defect `assertEffortUnsupported` refuses above — so the flag is left to
	// the kernel's own post-call Zod validation, which runs either way.
	return params.tools.map((t) => ({
		type: 'function' as const,
		function: {
			name: t.function.name,
			description: t.function.description ?? '',
			parameters: (t.function.parameters ?? {}) as Record<string, unknown>,
		},
	}))
}

export class DeepSeekProvider implements LLMProvider {
	readonly id = 'deepseek'
	readonly name = 'DeepSeek'
	readonly capabilities = DEEPSEEK_CAPABILITIES

	private client: OpenAI
	private defaultModel?: string
	private samplingMode: 'refuse' | 'ignore'

	constructor(config: DeepSeekConfig) {
		if (!config.apiKey) {
			throw new Error('DeepSeek API key is required. Set DEEPSEEK_API_KEY env variable.')
		}
		const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
			apiKey: config.apiKey,
			baseURL: config.baseURL ?? DEFAULT_BASE_URL,
		}
		if (config.timeout !== undefined) clientOptions.timeout = config.timeout
		clientOptions.defaultHeaders = { ...attributionHeaders(), ...(config.defaultHeaders ?? {}) }

		this.client = new OpenAI(clientOptions)
		this.defaultModel = config.model
		this.samplingMode = config.samplingInThinkingMode ?? 'refuse'
	}

	private resolveModel(params: ChatCompletionParams): string {
		const model = params.model || this.defaultModel
		if (!model) {
			throw new Error(
				'DeepSeekProvider: model is required. Pass `model` in config or on the chat call.',
			)
		}
		return model
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const model = this.resolveModel(params)
		assertEffortUnsupported(params)
		assertSamplingUsable(params, this.samplingMode)

		const sampling = thinkingEnabled(params.thinking)
			? {}
			: {
					temperature: params.temperature,
					top_p: params.topP,
					frequency_penalty: params.frequencyPenalty,
					presence_penalty: params.presencePenalty,
				}

		// Built as its own object so `stream: true` keeps its literal type and the
		// SDK's streaming overload is the one selected. Casting the whole
		// argument — the obvious way to smuggle `thinking` past a type that does
		// not know about it — widens `stream` to `boolean` and the call resolves
		// to the non-streaming overload, whose result has no async iterator.
		const body = {
			model,
			messages: toDeepSeekMessages(params.messages),
			stream: true as const,
			stream_options: { include_usage: true },
			tools: toDeepSeekTools(params),
			tool_choice: formatToolChoice(params.toolChoice),
			max_tokens: params.maxTokens,
			stop: params.stop,
			response_format: params.responseFormat,
			...sampling,
		}

		// Sent only when the caller said something. Absent means the vendor's own
		// default, which is thinking ON — see `thinkingEnabled`. The three
		// variants are the vendor's, and they are the same three the SDK's
		// `ThinkingConfig` declares, so this is a rename and not a mapping.
		//
		// Cast back to `typeof body` rather than to the SDK's parameter type: the
		// extra key rides along at runtime, and the literal `stream: true`
		// survives, which is what keeps the streaming overload selected.
		const withThinking = (
			params.thinking ? { ...body, thinking: { type: params.thinking.type } } : body
		) as typeof body

		let stream: Awaited<ReturnType<typeof this.client.chat.completions.create>>
		try {
			stream = await this.client.chat.completions.create(withThinking, {
				signal: params.signal,
			})
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'deepseek', error: err })
		}

		// One reasoning block per turn on this wire: the vendor streams
		// `reasoning_content` as a flat run of deltas with no index and no
		// block boundaries, so index 0 is the whole of it rather than a guess.
		let reasoningOpen = false

		try {
			for await (const chunk of stream) {
				params.signal?.throwIfAborted()
				try {
					const choice = chunk.choices[0]
					const delta = choice?.delta as
						| { content?: string | null; reasoning_content?: string | null; tool_calls?: unknown[] }
						| undefined

					const toolCalls = (
						delta?.tool_calls as
							| Array<{
									index: number
									id?: string
									type?: 'function'
									function?: { name?: string; arguments?: string }
							  }>
							| undefined
					)?.map((tc) => ({
						index: tc.index,
						id: tc.id,
						type: tc.type,
						function: tc.function
							? { name: tc.function.name, arguments: tc.function.arguments }
							: undefined,
					}))

					const reasoningText = delta?.reasoning_content
					const finishReason = choice?.finish_reason
						? mapFinishReason(choice.finish_reason)
						: undefined
					const usage = chunk.usage ? parseUsage(chunk.usage as RawDeepSeekUsage) : undefined

					if (reasoningText) {
						reasoningOpen = true
						yield {
							id: chunk.id,
							delta: { reasoning: { index: 0, type: 'thinking', text: reasoningText } },
						}
					}

					// The block closes when content or a tool call starts, which is
					// the only boundary this wire gives. Without it a consumer's
					// reasoning pane never receives `done` and stays open for the
					// life of the run.
					const contentStarting =
						(delta?.content !== undefined && delta.content !== null) ||
						(toolCalls !== undefined && toolCalls.length > 0)
					if (reasoningOpen && contentStarting) {
						reasoningOpen = false
						yield { id: chunk.id, delta: { reasoning: { index: 0, done: true } } }
					}

					const hasDelta =
						(delta?.content !== undefined && delta.content !== null) ||
						(toolCalls !== undefined && toolCalls.length > 0)
					if (!hasDelta && !finishReason && !usage) continue

					yield {
						id: chunk.id,
						delta: { content: delta?.content ?? undefined, toolCalls },
						finishReason,
						usage,
					}
				} catch (parseErr) {
					if (isProviderRequestError(parseErr)) throw parseErr
					throw new ProviderRequestError({
						kind: 'server',
						providerId: 'deepseek',
						detail: 'the provider stream returned malformed data',
					})
				}
			}
			// A turn that was all reasoning and no content — the model thought
			// and then stopped — still has to close its block.
			if (reasoningOpen) {
				yield { id: 'deepseek-reasoning-close', delta: { reasoning: { index: 0, done: true } } }
			}
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'deepseek', error: err })
		}
	}

	async probeCredential(): Promise<void> {
		await this.client.models.list()
	}

	async listModels(): Promise<ModelInfo[]> {
		const page = await this.client.models.list()
		return page.data.map((m) => ({
			id: m.id,
			name: m.id,
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
