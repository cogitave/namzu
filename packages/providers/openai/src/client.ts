import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	ReasoningEffort,
	StreamChunk,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import { assertThinkingUnsupported } from '@namzu/sdk'
import { toolResultToText } from '@namzu/sdk'
import {
	ProviderRequestError,
	isCallerAbortError,
	isProviderRequestError,
	providerVendorError,
} from '@namzu/sdk'
import { attributionHeaders } from '@namzu/sdk'
import OpenAI from 'openai'
import type {
	ChatCompletionContentPart,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam,
	ChatCompletionTool,
	ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions'
import type { OpenAIConfig } from './types.js'

/**
 * Full capability set — this driver maps tools (`toOpenAITools`), streams
 * natively, and maps user-message image `attachments` into `image_url`
 * content parts with base64 data URIs (`toOpenAIMessages`).
 */
export const OPENAI_CAPABILITIES: ProviderCapabilities = {
	supportsNativeStructuredOutput: true,
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
	supportsDocuments: true,
	supportsToolResultImages: false,
	supportsToolResultDocuments: false,
}

const GPT_5_EFFORT = [
	'minimal',
	'low',
	'medium',
	'high',
] as const satisfies readonly ReasoningEffort[]
const GPT_5_1_EFFORT = [
	'none',
	'low',
	'medium',
	'high',
] as const satisfies readonly ReasoningEffort[]
const GPT_5_2_TO_5_5_EFFORT = [
	'none',
	'low',
	'medium',
	'high',
	'xhigh',
] as const satisfies readonly ReasoningEffort[]
// https://developers.openai.com/api/docs/models/gpt-6-astra (2026-09-08).
const GPT_6_ASTRA_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const GPT_5_6_EFFORT = [
	'none',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
] as const satisfies readonly ReasoningEffort[]

/**
 * Exact reasoning-effort levels published for a recognized OpenAI model id.
 *
 * `undefined` is deliberately different from an empty array. This driver also
 * serves compatible endpoints with model identifiers OpenAI does not publish;
 * claiming that such a model has no effort levels would be as false as claiming
 * that it accepts every level in the SDK vocabulary.
 */
export function openAIReasoningEffortLevels(model: string): readonly ReasoningEffort[] | undefined {
	const normalized = model.toLowerCase()
	if (normalized === 'gpt-6-astra') return GPT_6_ASTRA_EFFORT
	if (/^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(normalized)) {
		return GPT_5_6_EFFORT
	}
	if (/^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/.test(normalized)) {
		return GPT_5_2_TO_5_5_EFFORT
	}
	if (/^gpt-5\.4(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(normalized)) {
		return GPT_5_2_TO_5_5_EFFORT
	}
	if (/^gpt-5\.2(?:-\d{4}-\d{2}-\d{2})?$/.test(normalized)) {
		return GPT_5_2_TO_5_5_EFFORT
	}
	if (/^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/.test(normalized)) {
		return GPT_5_1_EFFORT
	}
	if (/^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(normalized)) {
		return GPT_5_EFFORT
	}
	return undefined
}

/** Whether a base URL names a host other than OpenAI's own API. */
function isCompatibleHost(baseURL: string | undefined): boolean {
	if (!baseURL) return false
	try {
		return new URL(baseURL).hostname !== 'api.openai.com'
	} catch {
		return false
	}
}

/** The most a compatible endpoint's listing may take before the window is left to the SDK's table. */
const WINDOW_LISTING_TIMEOUT_MS = 3_000
/** How long a failed listing is remembered, so a gateway without a usable listing is not asked every turn. */
const WINDOW_LISTING_RETRY_MS = 5 * 60_000

const EFFORT_VOCABULARY: readonly string[] = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
]
type InputModality = NonNullable<ModelInfo['inputModalities']>[number]
const INPUT_MODALITIES: readonly InputModality[] = ['text', 'image', 'document']

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

/** The first of these fields of `row` that holds a positive safe integer. */
function firstCount(row: Record<string, unknown> | undefined, wires: readonly string[]) {
	for (const wire of wires) {
		const value = row?.[wire]
		if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
	}
	return undefined
}

/** A price per token that is a number or a numeric string, as a rate per million tokens. */
function ratePerMillion(value: unknown): number | undefined {
	const perToken = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
	if (typeof perToken !== 'number' || !Number.isFinite(perToken) || perToken < 0) return undefined
	return Number((perToken * 1_000_000).toPrecision(12))
}

function inputModalitiesOf(
	row: Record<string, unknown>,
	capabilities: Record<string, unknown> | undefined,
): InputModality[] | undefined {
	// An explicit vision flag is the clearest statement a listing makes about images.
	if (capabilities?.vision === true) return ['text', 'image']
	if (capabilities?.vision === false) return ['text']
	const declared =
		row.input_modalities ??
		asRecord(row.architecture)?.input_modalities ??
		// A plain `modalities` list is read for a chat model only: on another task it may name outputs.
		(row.task === undefined || row.task === 'chat' ? row.modalities : undefined)
	if (!Array.isArray(declared)) return undefined
	const known = INPUT_MODALITIES.filter((kind) => declared.includes(kind))
	return known.length > 0 ? known : undefined
}

/**
 * Optional declarations returned by compatible model catalogues. Missing is unknown: a field is
 * read only where its meaning is stated (a limit, a flag, a list, a price in dollars per token), and
 * a value that could mean something else, such as a default output length or a price in a
 * gateway's own credits, is left out rather than guessed.
 */
function compatibleModelMetadata(model: unknown): Partial<ModelInfo> {
	const row = asRecord(model) ?? {}
	const capabilities = asRecord(row.capabilities)
	const result: Partial<ModelInfo> = {}

	// Catalogues spell the same limits several ways: the first spelling that holds a positive
	// integer wins.
	const contextWindow = firstCount(row, [
		'context_window_tokens',
		'context_window',
		'context_length',
		'max_model_len',
	])
	if (contextWindow !== undefined) result.contextWindow = contextWindow
	const maxOutputTokens =
		firstCount(row, ['maximum_output_tokens', 'max_output_tokens', 'max_completion_tokens']) ??
		firstCount(asRecord(row.top_provider), ['max_completion_tokens'])
	if (maxOutputTokens !== undefined) result.maxOutputTokens = maxOutputTokens

	const inputModalities = inputModalitiesOf(row, capabilities)
	if (inputModalities !== undefined) result.inputModalities = inputModalities

	// Tool use is assumed unless the listing says the model has none.
	if (capabilities?.tools === false) result.supportsToolUse = false

	// Dollars per token, the convention gateways share, as dollars per million. A price in another
	// currency, or a listing that does not say, is not a dollar price.
	const pricing = asRecord(row.pricing)
	const currency =
		typeof pricing?.currency === 'string' ? pricing.currency.toUpperCase() : undefined
	if (pricing && (currency === undefined || currency === 'USD')) {
		const input = ratePerMillion(pricing.prompt)
		const output = ratePerMillion(pricing.completion)
		if (input !== undefined) result.inputPrice = input
		if (output !== undefined) result.outputPrice = output
	}

	// The effort menu: listed outright, or as the values the endpoint accepts together with the
	// names it maps onto them. An endpoint that lists no values (null) has an unknown menu; one that
	// says it has no effort control has an empty menu.
	let offered: readonly unknown[] | undefined = Array.isArray(row.supported_reasoning_efforts)
		? row.supported_reasoning_efforts
		: undefined
	if (offered === undefined && Array.isArray(capabilities?.reasoning_effort_values)) {
		const aliases = asRecord(capabilities.reasoning_effort_aliases)
		offered = [...new Set([...capabilities.reasoning_effort_values, ...Object.keys(aliases ?? {})])]
	}
	const menu =
		offered !== undefined &&
		new Set(offered).size === offered.length &&
		offered.every((level) => typeof level === 'string' && EFFORT_VOCABULARY.includes(level))
			? (offered as ReasoningEffort[])
			: undefined
	if (menu) {
		result.reasoningEffortLevels = [...menu]
		const defaultEffort = row.reasoning_effort
		if (typeof defaultEffort === 'string' && menu.includes(defaultEffort as ReasoningEffort))
			result.reasoningEffortDefault = defaultEffort as ReasoningEffort
	} else if (offered === undefined && capabilities?.reasoning_effort === false) {
		result.reasoningEffortLevels = []
	}
	return result
}

function assertOpenAIReasoningEffort(model: string, effort: ReasoningEffort | undefined): void {
	if (effort === undefined) return
	const supported = openAIReasoningEffortLevels(model)
	if (supported === undefined || supported.includes(effort)) return
	throw new Error(
		`OpenAIProvider: effort "${effort}" is not supported by model "${model}". Supported levels: ${supported.join(', ')}. Choose one of those levels or omit \`effort\`.`,
	)
}

/**
 * Add the current effort vocabulary without widening any other vendor field.
 *
 * The installed vendor client declaration predates `max`, while the current
 * API model catalogue already publishes it for GPT-5.6. `ultra` remains valid
 * only for an unknown compatible endpoint here: every recognized official
 * model rejects it above before this bounded cast is reached.
 */
function withReasoningEffort(
	request: Omit<ChatCompletionCreateParamsStreaming, 'reasoning_effort'>,
	effort: ReasoningEffort | undefined,
): ChatCompletionCreateParamsStreaming {
	if (effort === undefined) return request
	return {
		...request,
		reasoning_effort: effort,
	} as ChatCompletionCreateParamsStreaming
}

type OpenAIFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call'

type NamzuFinishReason = ChatCompletionResponse['finishReason']

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

/**
 * Refuse an extended-thinking request this driver does not implement.
 *
 * The parameter was accepted and dropped, so a caller who had asked for
 * reasoning got an ordinary completion: no thinking, no reasoning blocks,
 * no error — and the empty reasoning array reads as "the model did not
 * reason" rather than "nobody asked it to". Turning it OFF is honoured as
 * a no-op, because that is the state the driver is already in.
 */
export function assertThinkingSupported(params: {
	thinking?: { type: 'adaptive' | 'enabled' | 'disabled' }
}): void {
	// Delegates now. The rule was decided here and then applied only here,
	// while five sibling drivers went on dropping the field silently — so it
	// moved to the SDK where a new driver inherits it instead of re-deciding
	// it. Kept as a named export because it is one, and removing it would
	// break a caller for no gain.
	assertThinkingUnsupported('OpenAIProvider', { thinking: params.thinking })
}

/**
 * Refuse a document whose citations this wire cannot return.
 *
 * Citations are the difference between an answer you trust and one you
 * verify, and this request format has no mechanism to carry them back.
 * Sending the document anyway would answer the question and quietly drop
 * the checkability the caller specifically asked for — the caller would
 * see prose, no error, and an empty `citations` array they might read as
 * "the model cited nothing" rather than "nobody asked".
 */
function assertCitationsSupported(
	attachment: { citations?: boolean; name?: string },
	index: number,
): void {
	if (!attachment.citations) return
	const which = attachment.name ?? `attachment ${index}`
	throw new Error(
		`This provider cannot return citations, and ${which} asked for them. Drop \`citations\` to send the document without them, or use a provider whose capabilities include citation support.`,
	)
}

export function toOpenAIMessages(
	messages: ChatCompletionParams['messages'],
): ChatCompletionMessageParam[] {
	const converted = messages.map((msg): ChatCompletionMessageParam => {
		if (msg.role === 'system') {
			return { role: 'system', content: msg.content }
		}
		if (msg.role === 'user') {
			// User message with attachments → multimodal content parts, text
			// first. Images become an `image_url` part carrying a base64 data
			// URI; documents become a `file` part. Plain text-only user
			// messages keep the string form.
			if (msg.attachments && msg.attachments.length > 0) {
				const parts: ChatCompletionContentPart[] = []
				if (msg.content.length > 0) {
					parts.push({ type: 'text', text: msg.content })
				}
				for (const [index, att] of msg.attachments.entries()) {
					if (att.type === 'document') {
						// A document is not an image with a different media
						// type. Every attachment used to become an `image_url`,
						// so a PDF went up as `data:application/pdf;base64,...`
						// inside an image part — while the capability set
						// claimed documents were supported.
						assertCitationsSupported(att, index)
						parts.push({
							type: 'file',
							file: {
								file_data: `data:${att.mediaType};base64,${att.data}`,
								...(att.name ? { filename: att.name } : {}),
							},
						} as ChatCompletionContentPart)
						continue
					}
					if (att.type === 'stored') {
						// Unreachable through `query`, which resolves stored
						// attachments before a driver sees them. REFUSED rather
						// than skipped because the alternative is a user message
						// that silently lost its image: the model answers about a
						// picture it never saw, confidently, and nothing says why.
						throw new Error(
							`A stored attachment ("${att.ref}") reached the driver unresolved. Resolve it against the run's attachment store before sending.`,
						)
					}
					parts.push({
						type: 'image_url',
						image_url: { url: `data:${att.mediaType};base64,${att.data}` },
					})
				}
				return { role: 'user', content: parts }
			}
			return { role: 'user', content: msg.content }
		}
		if (msg.role === 'tool') {
			return {
				role: 'tool',
				// Tool messages are text-only on this wire, so a content block
				// degrades to an honest placeholder rather than having its
				// base64 payload dumped as text.
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
	// Interrupted or foreign reasoning-only turns can have no content on this
	// wire. Do not send invalid empty assistant entries, or invent filler text.
	// Filter after conversion: only fields this driver actually sends count.
	// Keep tool-only turns and leave the source history (including reasoning) intact.
	return converted.filter(
		(msg) => msg.role !== 'assistant' || Boolean(msg.content) || (msg.tool_calls?.length ?? 0) > 0,
	)
}

/**
 * Tool schemas, with constrained generation where the caller asked for it.
 *
 * `enforceToolInputSchema` names the tools whose schema should be enforced
 * rather than suggested. Both sibling drivers consumed it; this one dropped
 * it on the floor, so a caller who had asked for a guaranteed-valid tool
 * input got a best-effort one — and found out from a repair attempt rather
 * than from an error.
 *
 * This wire is the one the flag maps onto most directly: it takes `strict`
 * on the function itself.
 */
export function toOpenAITools(params: ChatCompletionParams): ChatCompletionTool[] | undefined {
	if (!params.tools || params.tools.length === 0) return undefined
	const enforced = new Set(params.enforceToolInputSchema ?? [])
	return params.tools.map((t) => ({
		type: 'function' as const,
		function: {
			name: t.function.name,
			description: t.function.description ?? '',
			parameters: (t.function.parameters ?? {}) as Record<string, unknown>,
			...(enforced.has(t.function.name) ? { strict: true } : {}),
		},
	}))
}

export class OpenAIProvider implements LLMProvider {
	readonly id = 'openai'
	readonly name = 'OpenAI'
	readonly capabilities = OPENAI_CAPABILITIES

	private client: OpenAI
	private defaultModel?: string
	/** Whether requests go somewhere other than OpenAI's own API, which is where a model's window is worth asking for. */
	private readonly compatibleHost: boolean
	/** The windows a compatible endpoint's last fulfilled listing declared, by model id. */
	private declaredWindows?: Map<string, number>
	/** Before this time (ms since the epoch) a failed listing is not asked for again. */
	private windowListingRetryAt = 0
	private thinkingOffFields: OpenAIConfig['thinkingOffFields']

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
		if (config.maxRetries !== undefined) clientOptions.maxRetries = config.maxRetries
		// Merged rather than replaced. Assigning `config.defaultHeaders`
		// straight over would drop attribution for exactly the hosts that
		// customise their transport.
		clientOptions.defaultHeaders = {
			...attributionHeaders(),
			...(config.defaultHeaders ?? {}),
		}

		this.client = new OpenAI(clientOptions)
		this.defaultModel = config.model
		this.thinkingOffFields = config.thinkingOffFields
		// The client reads the standard base-URL variable when none is given, so that is where requests go.
		this.compatibleHost = isCompatibleHost(config.baseURL ?? process.env.OPENAI_BASE_URL)
	}

	/**
	 * The window the runtime measures compaction against, as a compatible endpoint's own model
	 * listing declares it, or `undefined` when it declares none, which leaves the SDK's table to
	 * answer. The table is a hand-kept guess by model name; an endpoint that serves a model knows
	 * how long a prompt it takes. OpenAI's own API declares no window, so it is not asked.
	 *
	 * The listing is asked once and a fulfilled one is kept. A failure is remembered for a few
	 * minutes, so an endpoint with no usable listing is not asked at the start of every turn, and a
	 * listing that hangs is cut short. Neither ever fails a turn.
	 */
	async resolveContextWindow(model: string, signal?: AbortSignal): Promise<number | undefined> {
		signal?.throwIfAborted()
		if (!this.compatibleHost) return undefined
		if (!this.declaredWindows) {
			if (Date.now() < this.windowListingRetryAt) return undefined
			const controller = new AbortController()
			const forward = () => controller.abort()
			signal?.addEventListener('abort', forward, { once: true })
			const timer = setTimeout(forward, WINDOW_LISTING_TIMEOUT_MS)
			try {
				const listed = await this.listModels(controller.signal)
				this.declaredWindows ??= new Map(
					listed.flatMap((entry) =>
						entry.contextWindow !== undefined ? [[entry.id, entry.contextWindow] as const] : [],
					),
				)
			} catch {
				// The listing is a refinement; a turn must not fail because it is down.
				signal?.throwIfAborted()
				this.windowListingRetryAt = Date.now() + WINDOW_LISTING_RETRY_MS
				return undefined
			} finally {
				clearTimeout(timer)
				signal?.removeEventListener('abort', forward)
			}
		}
		return this.declaredWindows.get(model)
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

	reasoningEffortLevelsFor(model: string): readonly ReasoningEffort[] | undefined {
		return openAIReasoningEffortLevels(model)
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const model = this.resolveModel(params)
		assertThinkingSupported(params)
		assertOpenAIReasoningEffort(model, params.effort)

		// A call that asked for no effort (or for thinking to be off) means no
		// reasoning at all. `reasoning_effort` alone is ignored by some compatible
		// endpoints, so the endpoint's own switch goes along with it.
		const reasoningOff = params.effort === 'none' || params.thinking?.type === 'disabled'
		const offFields = reasoningOff
			? typeof this.thinkingOffFields === 'function'
				? this.thinkingOffFields(model)
				: this.thinkingOffFields
			: undefined

		let stream: Awaited<ReturnType<typeof this.client.chat.completions.create>>
		try {
			stream = await this.client.chat.completions.create(
				withReasoningEffort(
					{
						model,
						messages: toOpenAIMessages(params.messages),
						stream: true,
						stream_options: { include_usage: true },
						tools: toOpenAITools(params),
						tool_choice: formatToolChoice(params.toolChoice),
						parallel_tool_calls: params.parallelToolCalls,
						temperature: params.temperature,
						max_tokens: params.maxTokens,
						top_p: params.topP,
						frequency_penalty: params.frequencyPenalty,
						presence_penalty: params.presencePenalty,
						stop: params.stop,
						response_format: params.responseFormat,
						...(offFields ?? {}),
					},
					params.effort,
				),
				// Per-request abort: a Stop tears the in-flight SSE request down.
				{ signal: params.signal },
			)
		} catch (err) {
			// The vendor SDK builds its error message FROM the response body, so a
			// credential the upstream echoed back is already inside `err.message`
			// before this code runs (proven with a planted fake token). Classify from
			// the status and drop the vendor error entirely — no re-throw, no
			// `cause`, because a `cause` is exactly what a structured logger walks.
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'openai', error: err })
		}

		// A choice reported why it stopped. A stream that closes without one was
		// cut by the connection, and what it carried is not a whole response.
		let finished = false
		try {
			for await (const chunk of stream) {
				// Stop pulling promptly on abort; `for await` calls the stream's
				// `.return()` on this throw, releasing the connection.
				params.signal?.throwIfAborted()
				try {
					const choice = chunk.choices[0]
					const delta = choice?.delta
					// Compatible endpoints can expose public reasoning under either
					// spelling. Structured or encrypted values are not public text.
					const extra = delta as { reasoning_content?: unknown; reasoning?: unknown } | undefined
					const emitted =
						typeof extra?.reasoning_content === 'string'
							? extra.reasoning_content
							: typeof extra?.reasoning === 'string'
								? extra.reasoning
								: undefined
					// Reasoning that arrives although none was asked for is dropped,
					// so a request for no thinking never shows or bills it as thought.
					const reasoning = reasoningOff ? undefined : emitted

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
						(reasoning !== undefined && reasoning.length > 0) ||
						(toolCalls && toolCalls.length > 0)
					const finishReason = choice?.finish_reason
						? mapFinishReason(choice.finish_reason)
						: undefined
					const usage = chunk.usage ? parseUsage(chunk.usage) : undefined
					if (finishReason) finished = true

					if (!hasDelta && !finishReason && !usage) continue

					yield {
						id: chunk.id,
						delta: {
							content: delta?.content ?? undefined,
							...(reasoning
								? { reasoning: { index: 0, type: 'thinking' as const, text: reasoning } }
								: {}),
							toolCalls,
						},
						finishReason,
						// A content filter stopped the reply; the API says nothing more.
						...(finishReason === 'content_filter' ? { refusal: {} } : {}),
						usage,
					}
				} catch (parseErr) {
					if (isProviderRequestError(parseErr)) throw parseErr
					throw new ProviderRequestError({
						kind: 'server',
						providerId: 'openai',
						detail: 'the provider stream returned malformed data',
					})
				}
			}
			if (!finished) {
				throw new ProviderRequestError({
					kind: 'network',
					providerId: 'openai',
					detail: 'the connection closed before the response finished',
				})
			}
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'openai', error: err })
		}
	}

	/**
	 * Declared even though this driver's listing already fails correctly on a
	 * bad key. The check is a declared capability rather than something inferred
	 * from whether a menu happened to throw, so a driver that answers the
	 * question has to say so — otherwise it is reported unverifiable, which is
	 * the honest default and would be a regression here.
	 */
	async probeCredential(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted()
		await this.client.models.list(signal ? { signal } : undefined)
		signal?.throwIfAborted()
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		signal?.throwIfAborted()
		const page = await this.client.models.list(signal ? { signal } : undefined)
		signal?.throwIfAborted()
		return page.data.map((m) => ({
			id: m.id,
			name: m.id,
			supportsToolUse: true,
			supportsStreaming: true,
			...compatibleModelMetadata(m),
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
