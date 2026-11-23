import type {
	AssistantTextPart,
	ChatCompletionParams,
	InferenceSpeed,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	ProviderRoute,
	ReasoningEffort,
	StreamChunk,
	TokenUsage,
} from '@namzu/sdk'
import {
	ProviderRequestError,
	attributionHeaders,
	isCallerAbortError,
	isProviderRequestError,
	providerVendorError,
	selectAssistantText,
	toToolResultBlocks,
} from '@namzu/sdk'
import OpenAI from 'openai'
import type {
	ResponseCreateParamsStreaming,
	ResponseFunctionCallOutputItemList,
	ResponseInputImage,
	ResponseInputImageContent,
	ResponseInputItem,
	ResponseInputMessageContentList,
	ResponseOutputItem,
	ResponseStreamEvent,
	Tool,
} from 'openai/resources/responses/responses'

import { type FastTier, assertFastModeAccepted, servedSpeed } from './fast-mode.js'
import { declaredContextWindow, effectiveWindowFraction } from './model-limits.js'
import type { CodexConfig } from './types.js'

export const CODEX_CAPABILITIES: ProviderCapabilities = {
	supportsHostedWebSearch: true,
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsNativeStructuredOutput: true,
	supportsVision: true,
	supportsDocuments: false,
	supportsToolResultImages: true,
	supportsToolResultDocuments: false,
}

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

interface SubscriptionReasoningProfile {
	readonly default?: ReasoningEffort
	readonly levels: readonly ReasoningEffort[]
}

const KNOWN_EFFORT_LEVELS: readonly ReasoningEffort[] = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
]

/** Unknown levels invalidate an exact menu; filtering them would invent one. */
function subscriptionReasoningProfile(
	item: Record<string, unknown>,
): SubscriptionReasoningProfile | undefined {
	if (!Array.isArray(item.supported_reasoning_levels)) return undefined
	const levels: ReasoningEffort[] = []
	for (const entry of item.supported_reasoning_levels) {
		const effort = record(entry)?.effort
		if (typeof effort !== 'string' || !KNOWN_EFFORT_LEVELS.includes(effort as ReasoningEffort))
			return undefined
		if (levels.includes(effort as ReasoningEffort)) return undefined
		levels.push(effort as ReasoningEffort)
	}
	const defaultLevel = item.default_reasoning_level
	return {
		levels: Object.freeze(levels),
		...(typeof defaultLevel === 'string' && levels.includes(defaultLevel as ReasoningEffort)
			? { default: defaultLevel as ReasoningEffort }
			: {}),
	}
}

interface CodexReplayState {
	readonly kind: 'namzu.codex.responses'
	readonly version: 1
	readonly route: ProviderRoute
	readonly content: string | null
	readonly textParts?: readonly AssistantTextPart[]
	readonly toolCalls: readonly {
		readonly id: string
		readonly name: string
		readonly arguments: string
	}[]
	readonly items: readonly ResponseOutputItem[]
}

function sameRoute(left: ProviderRoute, right: ProviderRoute): boolean {
	return (
		left.providerId === right.providerId &&
		left.model === right.model &&
		left.chainIndex === right.chainIndex
	)
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function isRoute(value: unknown): value is ProviderRoute {
	const route = record(value)
	return (
		typeof route?.providerId === 'string' &&
		typeof route.model === 'string' &&
		Number.isInteger(route.chainIndex) &&
		(route.chainIndex as number) >= 0
	)
}

function durableToolCalls(
	message: Extract<ChatCompletionParams['messages'][number], { role: 'assistant' }>,
): CodexReplayState['toolCalls'] {
	return (message.toolCalls ?? []).map((call) => ({
		id: call.id,
		name: call.function.name,
		arguments: call.function.arguments,
	}))
}

function isCodexReplayState(value: unknown): value is CodexReplayState {
	const state = record(value)
	if (
		state?.kind !== 'namzu.codex.responses' ||
		state.version !== 1 ||
		!isRoute(state.route) ||
		(state.content !== null && typeof state.content !== 'string') ||
		!Array.isArray(state.toolCalls) ||
		!Array.isArray(state.items)
	) {
		return false
	}
	return state.toolCalls.every((item) => {
		const call = record(item)
		return (
			typeof call?.id === 'string' &&
			typeof call.name === 'string' &&
			typeof call.arguments === 'string'
		)
	})
}

function replayItems(
	message: Extract<ChatCompletionParams['messages'][number], { role: 'assistant' }>,
	targetRoute: ProviderRoute,
): readonly ResponseOutputItem[] | null {
	const source = message.source
	if (!source || source.type !== 'model' || !sameRoute(source, targetRoute)) return null
	const state = source.replayState
	if (!isCodexReplayState(state) || !sameRoute(state.route, source)) return null
	if (state.content !== message.content) return null
	if (
		state.textParts !== undefined &&
		JSON.stringify(state.textParts) !== JSON.stringify(message.textParts)
	)
		return null
	if (JSON.stringify(state.toolCalls) !== JSON.stringify(durableToolCalls(message))) return null
	return state.items
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * A tool-result image is a screenshot the model acts on by coordinate, and
 * `auto` lets the backend pick `low` — a 512-pixel view whose coordinates
 * are not the image's. `high` is accepted by every Responses model and keeps
 * any image up to 2048 px and 2 500 patches at its own size, which is the
 * budget `computer_use` fits its screenshots to. (`original` would also keep
 * it, but only gpt-5.4 and later accept it, and this driver serves older
 * models too.) User attachments keep `auto`.
 */
const TOOL_RESULT_IMAGE_DETAIL = 'high' as const

function codexImage(
	data: string,
	mediaType: string,
	source: 'user attachment' | 'tool result',
): ResponseInputImage & ResponseInputImageContent {
	if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
		throw new Error(
			`CodexProvider: ${source} image type '${mediaType}' is not supported. Use image/png, image/jpeg, image/webp, or image/gif.`,
		)
	}
	return {
		type: 'input_image',
		detail: source === 'tool result' ? TOOL_RESULT_IMAGE_DETAIL : 'auto',
		image_url: `data:${mediaType};base64,${data}`,
	}
}

function codexUserContent(
	message: Extract<ChatCompletionParams['messages'][number], { role: 'user' }>,
): string | ResponseInputMessageContentList {
	const attachments = message.attachments ?? []
	if (attachments.length === 0) return message.content
	const content: ResponseInputMessageContentList = []
	if (message.content.length > 0) content.push({ type: 'input_text', text: message.content })
	for (const attachment of attachments) {
		if (attachment.type === 'stored') {
			throw new Error(
				'CodexProvider: an unresolved stored attachment reached the driver. Configure an AttachmentStore so Namzu can resolve its bytes before the model request.',
			)
		}
		if (attachment.type === 'document') {
			throw new Error(
				'CodexProvider: this subscription transport does not support document input. Route the turn to a document-capable provider.',
			)
		}
		if (attachment.modelOmission) {
			throw new Error(
				'CodexProvider: an image marked for model omission reached the driver without request projection.',
			)
		}
		content.push(codexImage(attachment.data, attachment.mediaType, 'user attachment'))
	}
	return content
}

function codexToolOutput(
	content: Extract<ChatCompletionParams['messages'][number], { role: 'tool' }>['content'],
): string | ResponseFunctionCallOutputItemList {
	if (typeof content === 'string') return content
	if (content.length === 0) return ''
	const output: ResponseFunctionCallOutputItemList = []
	for (const block of toToolResultBlocks(content)) {
		if (block.type === 'text') {
			output.push({ type: 'input_text', text: block.text })
			continue
		}
		if (block.type === 'document') {
			throw new Error(
				'CodexProvider: this subscription transport does not support document tool results. Route the turn to a provider whose tool-result wire admits documents.',
			)
		}
		if (block.modelOmission) {
			throw new Error(
				'CodexProvider: a tool image marked for model omission reached the driver without request projection.',
			)
		}
		output.push(codexImage(block.data, block.mediaType, 'tool result'))
	}
	return output
}

export function toCodexInput(
	messages: ChatCompletionParams['messages'],
	targetRoute: ProviderRoute,
	openingSystemRun = messages.findIndex((message) => message.role !== 'system'),
): ResponseInputItem[] {
	const input: ResponseInputItem[] = []
	const opening = openingSystemRun < 0 ? messages.length : openingSystemRun
	for (const [at, message] of messages.entries()) {
		if (message.role === 'system') {
			// The opening run is `instructions`; a later one keeps its place.
			if (at >= opening && message.content) {
				input.push({ type: 'message', role: 'developer', content: message.content })
			}
			continue
		}
		if (message.role === 'user') {
			input.push({
				type: 'message',
				role: 'user',
				content: codexUserContent(message),
			})
			continue
		}
		if (message.role === 'tool') {
			input.push({
				type: 'function_call_output',
				call_id: message.toolCallId,
				output: codexToolOutput(message.content),
			})
			continue
		}
		const replayed = replayItems(message, targetRoute)
		if (replayed) {
			input.push(...(replayed as ResponseInputItem[]))
			continue
		}
		if (message.content) {
			input.push({
				type: 'message',
				role: 'assistant',
				content: message.content,
			})
		}
		for (const call of message.toolCalls ?? []) {
			input.push({
				type: 'function_call',
				call_id: call.id,
				name: call.function.name,
				arguments: call.function.arguments,
			})
		}
	}
	return input
}

export function toCodexTools(params: ChatCompletionParams): Tool[] | undefined {
	const tools: Tool[] = (params.tools ?? []).map((tool) => ({
		type: 'function',
		name: tool.function.name,
		description: tool.function.description ?? '',
		parameters: tool.function.parameters ?? {},
		// The ChatGPT Codex backend validates `strict: true` against a narrower
		// Responses schema than the Chat Completions endpoint. In particular,
		// every composition branch needs an explicit type and every object
		// property must also be required. Namzu model schemas deliberately keep
		// conditional edit shapes optional and validate the selected shape at
		// execution, so claiming strictness rejects the whole request before the
		// model can answer. The Codex client uses the same boundary for its own
		// tools: Responses function tools are sent with `strict: false` and tool
		// inputs are validated by the runtime. `enforceToolInputSchema` remains a
		// provider hint; this transport cannot truthfully consume it for Namzu's
		// general tool-schema contract.
		strict: false,
	}))
	if (params.webSearch) {
		if (params.webSearch.mode !== 'live' && params.webSearch.mode !== 'cached')
			throw new Error('Invalid web search mode.')
		// The subscription wire supports this field; the installed API SDK's Tool type predates it.
		const hosted: Tool & { external_web_access: boolean } = {
			type: 'web_search',
			external_web_access: params.webSearch.mode === 'live',
		}
		tools.push(hosted)
	}
	return tools.length ? tools : undefined
}

function responseUsage(
	usage: {
		input_tokens?: number
		output_tokens?: number
		total_tokens?: number
		input_tokens_details?: { cached_tokens?: number }
	},
	servedTier?: unknown,
	requestedSpeed?: InferenceSpeed,
): TokenUsage {
	const promptTokens = usage.input_tokens ?? 0
	const completionTokens = usage.output_tokens ?? 0
	return {
		promptTokens,
		completionTokens,
		totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
		cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
		cacheWriteTokens: 0,
		...servedSpeed(servedTier, requestedSpeed),
	}
}

/**
 * The speed tiers a model listing entry offers, from the current
 * `service_tiers` objects and the older `additional_speed_tiers` strings.
 * Only the two tiers this driver can request are kept: `priority` (or `fast`)
 * is fast, `ultrafast` is ultrafast; anything else, flex included, is not a
 * speed tier here.
 */
function subscriptionSpeedTiers(item: Record<string, unknown>): readonly FastTier[] {
	const tiers = new Set<FastTier>()
	const note = (id: unknown) => {
		if (id === 'priority' || id === 'fast') tiers.add('fast')
		else if (id === 'ultrafast') tiers.add('ultrafast')
	}
	if (Array.isArray(item.service_tiers)) {
		for (const entry of item.service_tiers) note(record(entry)?.id)
	}
	if (Array.isArray(item.additional_speed_tiers)) {
		for (const entry of item.additional_speed_tiers) note(entry)
	}
	return (['fast', 'ultrafast'] as const).filter((tier) => tiers.has(tier))
}

function buildRequest(
	params: ChatCompletionParams,
	model: string,
	targetRoute: ProviderRoute,
	supportedEffort: readonly ReasoningEffort[] | undefined,
	downgrade: SubscriptionDowngrade = NO_DOWNGRADE,
): ResponseCreateParamsStreaming {
	if (
		params.effort !== undefined &&
		supportedEffort !== undefined &&
		!supportedEffort.includes(params.effort)
	) {
		throw new Error(
			`CodexProvider: effort "${params.effort}" is not supported by model "${model}". Supported levels: ${supportedEffort.join(', ')}. Choose one of those levels or omit \`effort\`.`,
		)
	}
	if (params.thinking?.type === 'enabled') {
		throw new Error(
			'CodexProvider: manual thinking budgets are not a Responses API capability. Use adaptive thinking or omit `thinking`.',
		)
	}
	if (params.thinking?.type === 'disabled' && params.effort !== 'none') {
		throw new Error(
			'CodexProvider: disabling reasoning requires `effort: "none"`; omitting that level would not prove reasoning was disabled.',
		)
	}
	// Only the system messages that open the conversation are the standing
	// instructions. The runtime places a step's preamble (changing guidance,
	// skills, turn notes) later in the list; hoisting it into `instructions`
	// put changing text at the very front of every request, so no request
	// shared a cache prefix with the one before it. Later system messages stay
	// where they were, as developer messages in the input.
	let openingRun = 0
	while (params.messages[openingRun]?.role === 'system') openingRun++
	// After the backend refused the new shape, every system message goes back
	// into `instructions` and none is sent as a developer item.
	if (downgrade.legacyShape) openingRun = params.messages.length
	const instructions = (
		downgrade.legacyShape
			? params.messages.filter((message) => message.role === 'system')
			: params.messages.slice(0, openingRun)
	)
		.map((message) => message.content)
		.join('\n\n')
	const request = {
		model,
		stream: true,
		store: false,
		instructions: instructions || undefined,
		input: toCodexInput(params.messages, targetRoute, openingRun),
		// One key for the whole conversation routes every request to the same
		// cache; without it the backend keys on the request alone.
		...(params.cacheKey && !downgrade.noCacheKey ? { prompt_cache_key: params.cacheKey } : {}),
		// The Codex subscription request schema deliberately has no
		// `max_output_tokens` member. `ChatCompletionParams.maxTokens` is a public
		// API control, but projecting it onto this route makes the whole request
		// invalid; the backend owns the output budget here.
		// The subscription Responses backend expects these three fields even for a
		// turn that exposes no tools.  The ordinary public Responses endpoint admits
		// their omission, which is why the generated client types all make them
		// optional; the Codex wire does not have the same defaulting contract.
		tools: toCodexTools(params) ?? [],
		tool_choice: (params.toolChoice ?? 'auto') as ResponseCreateParamsStreaming['tool_choice'],
		parallel_tool_calls: params.parallelToolCalls ?? true,
		include: ['reasoning.encrypted_content'],
		...(params.responseFormat
			? {
					text: {
						format:
							params.responseFormat.type === 'json_schema'
								? { type: 'json_schema', ...params.responseFormat.json_schema }
								: { type: 'json_object' },
					},
				}
			: {}),
		...(params.effort !== undefined
			? { reasoning: { effort: params.effort, summary: 'auto' } }
			: params.thinking?.type === 'adaptive'
				? { reasoning: { summary: 'auto' } }
				: {}),
	}
	// The installed client declaration predates the current advanced effort
	// vocabulary. The model-specific admission check above is the runtime
	// boundary; this cast only bridges that declaration lag.
	return request as ResponseCreateParamsStreaming
}

/**
 * What the subscription backend has refused of the newer request shape: the
 * `developer` input item, the `session_id` header, the `prompt_cache_key` body
 * field. Set once for the life of the process, by the one resend that the
 * refusal triggers; later requests go straight to the older shape.
 */
interface SubscriptionDowngrade {
	/** All system text joined into `instructions`, no developer items, no `session_id` header. */
	legacyShape: boolean
	/** The refusal named `prompt_cache_key`, so it is left off too. */
	noCacheKey: boolean
}

const NO_DOWNGRADE: SubscriptionDowngrade = { legacyShape: false, noCacheKey: false }
const subscriptionDowngrade: SubscriptionDowngrade = { legacyShape: false, noCacheKey: false }

/** Test seam: forget a downgrade recorded earlier in this process. */
export function resetSubscriptionDowngrade(): void {
	subscriptionDowngrade.legacyShape = false
	subscriptionDowngrade.noCacheKey = false
}

const REFUSED_SHAPE = /\bdeveloper\b|\brole\b|\binput\[\d*\]|session_id|prompt_cache_key/i

/**
 * A bad-request answer that names what the newer shape added. Anything else
 * (a different 400, any other status, a network failure) is not one.
 */
function refusedNewShape(error: unknown): { cacheKey: boolean } | undefined {
	if (typeof error !== 'object' || error === null) return undefined
	const status = (error as { status?: unknown }).status
	if (!(error instanceof OpenAI.BadRequestError) && status !== 400) return undefined
	const message = (error as { message?: unknown }).message
	if (typeof message !== 'string' || !REFUSED_SHAPE.test(message)) return undefined
	return { cacheKey: /prompt_cache_key/i.test(message) }
}

/**
 * What an account's model listing said, kept for the life of the process so a
 * provider rebuilt around a refreshed token still honours an advertised tier.
 * Keyed by account and endpoint, never by token.
 */
const listingByAccount = new Map<
	string,
	{
		speedTiers: Map<string, readonly FastTier[]>
		reasoningProfiles: Map<string, SubscriptionReasoningProfile>
		windows: Map<string, number>
	}
>()

/** The most a subscription listing may take before the window is left to the SDK's table. */
const WINDOW_LISTING_TIMEOUT_MS = 3_000
/** How long a failed listing is remembered, so a turn does not ask again every time. */
const WINDOW_LISTING_RETRY_MS = 5 * 60_000

export class CodexProvider implements LLMProvider {
	readonly id = 'codex'
	readonly name = 'OpenAI Codex'
	readonly capabilities = CODEX_CAPABILITIES

	private client: OpenAI
	private defaultModel?: string
	private reasoningProfiles = new Map<string, SubscriptionReasoningProfile>()
	/** Per model, the speed tiers the account's listing offers. Absent until a listing has answered. */
	private speedTiers?: Map<string, readonly FastTier[]>
	/** Per model, the window the account's listing states. Absent until a listing has answered. */
	private windows?: Map<string, number>
	private windowListingRetryAt = 0
	/** The listing in flight, shared by callers that arrive while it runs. */
	private windowListing?: Promise<boolean>
	private readonly listingKey: string

	constructor(config: CodexConfig) {
		if (!config.accessToken) throw new Error('Codex access token is required.')
		if (!config.accountId) throw new Error('Codex ChatGPT account id is required.')
		this.client = new OpenAI({
			apiKey: config.accessToken,
			baseURL: config.baseURL ?? DEFAULT_CODEX_BASE_URL,
			timeout: config.timeout,
			...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
			defaultHeaders: {
				...attributionHeaders(),
				'ChatGPT-Account-Id': config.accountId,
				originator: 'Codex Namzu',
				'User-Agent': 'Codex Namzu/1.0',
				...(config.defaultHeaders ?? {}),
			},
		})
		this.defaultModel = config.model
		this.listingKey = `${config.accountId}\u0000${config.baseURL ?? DEFAULT_CODEX_BASE_URL}`
		const known = listingByAccount.get(this.listingKey)
		if (known) {
			this.speedTiers = known.speedTiers
			this.reasoningProfiles = known.reasoningProfiles
			this.windows = known.windows
		}
	}

	private resolveModel(params: ChatCompletionParams): string {
		const model = params.model || this.defaultModel
		if (!model) throw new Error('CodexProvider: model is required.')
		return model
	}

	reasoningEffortLevelsFor(model: string): readonly ReasoningEffort[] | undefined {
		return this.reasoningProfiles.get(model.toLowerCase())?.levels
	}

	reasoningEffortDefaultFor(model: string): ReasoningEffort | undefined {
		return this.reasoningProfiles.get(model.toLowerCase())?.default
	}

	/**
	 * The speed tiers the account's listing offers for `model`. `undefined`
	 * until a listing has answered; once one has, a model it does not carry
	 * offers none.
	 */
	speedTiersFor(model: string): readonly FastTier[] | undefined {
		if (this.speedTiers === undefined) return undefined
		return this.speedTiers.get(model.toLowerCase()) ?? []
	}

	/**
	 * The window the runtime measures compaction against, as the account's model listing states
	 * it (scaled by the effective-percent the listing sends, when it sends one), or `undefined`
	 * when the listing states none, which leaves the SDK's table to answer.
	 *
	 * The listing is asked once per account and kept. A failure is remembered for a few minutes
	 * and a listing that hangs is cut short. Neither ever fails a turn; only the caller's own
	 * abort propagates.
	 */
	async resolveContextWindow(model: string, signal?: AbortSignal): Promise<number | undefined> {
		signal?.throwIfAborted()
		if (!this.windows) {
			if (Date.now() < this.windowListingRetryAt) return undefined
			this.windowListing ??= this.listForWindow().finally(() => {
				this.windowListing = undefined
			})
			const abandoned = new Promise<never>((_, reject) => {
				if (signal?.aborted) reject(signal.reason)
				signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
			})
			await Promise.race([this.windowListing, abandoned])
			signal?.throwIfAborted()
		}
		return this.windows?.get(model.toLowerCase())
	}

	/** One bounded listing for every caller waiting on it; a failure is remembered, never thrown. */
	private async listForWindow(): Promise<boolean> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), WINDOW_LISTING_TIMEOUT_MS)
		try {
			await this.listModels(controller.signal)
			return true
		} catch {
			this.windowListingRetryAt = Date.now() + WINDOW_LISTING_RETRY_MS
			return false
		} finally {
			clearTimeout(timer)
		}
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const model = this.resolveModel(params)
		const targetRoute = params.providerRoute ?? {
			providerId: this.id,
			model,
			chainIndex: 0,
		}
		const effortLevels = this.reasoningEffortLevelsFor(model)
		const built = buildRequest(params, model, targetRoute, effortLevels, subscriptionDowngrade)
		// A tier the account's listing does not offer is refused here, before
		// transport: the backend would drop it and serve standard speed while
		// the caller believes the request was honoured.
		const fast =
			params.speed === 'fast' || params.speed === 'ultrafast'
				? assertFastModeAccepted({
						route: 'subscription',
						model,
						tier: params.speed,
						advertised: this.speedTiersFor(model),
						firstPartyEndpoint: true,
					})
				: undefined
		const withTier = (body: ResponseCreateParamsStreaming) =>
			(fast ? { ...body, service_tier: fast.wire } : body) as ResponseCreateParamsStreaming
		const requestedSpeed =
			params.speed === 'fast' || params.speed === 'ultrafast' ? params.speed : undefined
		const send = (body: ResponseCreateParamsStreaming, sessionHeader: boolean) =>
			this.client.responses.create(withTier(body), {
				signal: params.signal,
				...(fast?.header || (sessionHeader && params.cacheKey)
					? {
							headers: {
								...(fast?.header ?? {}),
								...(sessionHeader && params.cacheKey ? { session_id: params.cacheKey } : {}),
							},
						}
					: {}),
			}) as Promise<AsyncIterable<ResponseStreamEvent>>
		let stream: AsyncIterable<ResponseStreamEvent>
		try {
			try {
				stream = await send(built, !subscriptionDowngrade.legacyShape)
			} catch (error) {
				// The backend refusing the newer shape is answered before any
				// output exists, so one resend in the older shape is safe. It is
				// remembered, so no later request sends the newer shape and nothing
				// is resent twice.
				const refused = subscriptionDowngrade.legacyShape ? undefined : refusedNewShape(error)
				const newShapeSent =
					built.input !== undefined &&
					(Boolean(params.cacheKey) ||
						(Array.isArray(built.input) &&
							built.input.some((item) => 'role' in item && item.role === 'developer')))
				if (!refused || !newShapeSent || params.signal?.aborted) throw error
				subscriptionDowngrade.legacyShape = true
				if (refused.cacheKey) subscriptionDowngrade.noCacheKey = true
				stream = await send(
					buildRequest(params, model, targetRoute, effortLevels, subscriptionDowngrade),
					false,
				)
			}
		} catch (error) {
			if (isCallerAbortError(error, params.signal)) throw params.signal?.reason ?? error
			if (isProviderRequestError(error)) throw error
			throw providerVendorError({ providerId: this.id, error })
		}

		const callIndex = new Map<string, number>()
		// The subscription backend can leave response.completed.output empty.
		// Retain finalized items, including opaque reasoning, at their output index;
		// added items and deltas are not a complete native replay record.
		const completedItems = new Map<number, ResponseOutputItem>()
		const textItems = new Map<string, Omit<AssistantTextPart, 'text'>>()
		let nextCallIndex = 0
		let responseId = 'codex-response'
		// A terminal event arrived. A stream that closes without one was cut by
		// the connection: what it carried is not a whole response.
		let finished = false
		try {
			for await (const event of stream) {
				params.signal?.throwIfAborted()
				switch (event.type) {
					case 'response.created':
						responseId = event.response.id
						break
					case 'response.output_text.delta': {
						const textPart = textItems.get(event.item_id)
						yield {
							id: responseId,
							delta: {
								content: event.delta,
								...(textPart ? { textPart } : {}),
							},
						}
						break
					}
					case 'response.reasoning_summary_text.delta':
						yield {
							id: responseId,
							delta: {
								reasoning: {
									index: event.output_index,
									type: 'thinking',
									text: event.delta,
								},
							},
						}
						break
					case 'response.reasoning_summary_text.done':
						yield {
							id: responseId,
							delta: {
								reasoning: {
									index: event.output_index,
									type: 'thinking',
									done: true,
								},
							},
						}
						break
					case 'response.output_item.added':
						if (
							event.item.type === 'message' &&
							(event.item.phase === 'commentary' || event.item.phase === 'final_answer')
						)
							textItems.set(event.item.id, {
								id: event.item.id,
								phase: event.item.phase,
							})
						if (event.item.type === 'web_search_call') {
							yield {
								id: responseId,
								delta: {
									hostedTool: {
										id: event.item.id,
										name: 'web_search',
										status: 'running',
										...webSearchDetail(event.item),
									},
								},
							}
						}
						if (event.item.type === 'function_call') {
							const index = nextCallIndex++
							callIndex.set(event.item.id ?? event.item.call_id, index)
							callIndex.set(event.item.call_id, index)
							yield {
								id: responseId,
								delta: {
									toolCalls: [
										{
											index,
											id: event.item.call_id,
											type: 'function',
											function: {
												name: event.item.name,
												arguments: event.item.arguments,
											},
										},
									],
								},
							}
						}
						break
					case 'response.function_call_arguments.delta': {
						const index = callIndex.get(event.item_id) ?? event.output_index
						yield {
							id: responseId,
							delta: {
								toolCalls: [{ index, function: { arguments: event.delta } }],
							},
						}
						break
					}
					case 'response.output_item.done':
						completedItems.set(event.output_index, event.item)
						if (event.item.type === 'web_search_call') {
							yield {
								id: responseId,
								delta: {
									hostedTool: {
										id: event.item.id,
										name: 'web_search',
										status: event.item.status === 'completed' ? 'completed' : 'failed',
										...webSearchDetail(event.item),
									},
								},
							}
						}
						if (event.item.type === 'function_call') {
							yield {
								id: responseId,
								delta: {
									toolCallEnd: {
										index: callIndex.get(event.item.id ?? event.item.call_id) ?? event.output_index,
										id: event.item.call_id,
									},
								},
							}
						}
						break
					case 'response.completed': {
						// A populated final snapshot remains authoritative. Never concatenate
						// it with streamed items: that would replay the same tool call twice.
						const output = event.response.output?.length
							? event.response.output
							: [...completedItems].sort(([left], [right]) => left - right).map(([, item]) => item)
						const calls = output
							.filter((item) => item.type === 'function_call')
							.map((item) => ({
								id: item.call_id,
								name: item.name,
								arguments: item.arguments,
							}))
						const textParts: AssistantTextPart[] = output
							.filter((item) => item.type === 'message')
							.map((item) => ({
								id: item.id,
								...(item.phase === 'commentary' || item.phase === 'final_answer'
									? { phase: item.phase }
									: {}),
								text: item.content
									.filter((part) => part.type === 'output_text')
									.map((part) => part.text)
									.join(''),
							}))
						const phased = textParts.some((part) => part.phase !== undefined)
						let content = phased
							? selectAssistantText(textParts)
							: textParts.map((part) => part.text).join('')
						const sources = new Map<string, string>()
						for (const item of output) {
							if (item.type !== 'message') continue
							for (const part of item.content) {
								if (part.type !== 'output_text') continue
								for (const annotation of part.annotations ?? []) {
									if (
										annotation.type === 'url_citation' &&
										/^https?:\/\//i.test(annotation.url) &&
										!content.includes(annotation.url)
									) {
										sources.set(annotation.url, annotation.title)
									}
								}
							}
						}
						if (sources.size) {
							const links = [...sources]
								.map(
									([url, title]) =>
										`[${title.replace(/[\[\]\r\n]/g, ' ')}](<${url.replace(/[<>\s]/g, (c) => encodeURIComponent(c))}>)`,
								)
								.join(' · ')
							const suffix = `\n\nSources: ${links}`
							content += suffix
							let partIndex = textParts.length - 1
							for (let i = textParts.length - 1; i >= 0; i--) {
								if (textParts[i]?.phase === 'final_answer') {
									partIndex = i
									break
								}
							}
							const part = textParts[partIndex]
							if (part) textParts[partIndex] = { ...part, text: part.text + suffix }
							// The driver's text, not the model's.
							yield {
								id: responseId,
								delta: { content: suffix, contentOrigin: 'driver' },
							}
						}
						const replayState: CodexReplayState = {
							kind: 'namzu.codex.responses',
							version: 1,
							route: targetRoute,
							content: content || null,
							...(phased ? { textParts } : {}),
							toolCalls: calls,
							items: output,
						}
						finished = true
						yield {
							id: event.response.id,
							delta: {},
							...(phased ? { textParts } : {}),
							finishReason: calls.length > 0 ? 'tool_calls' : 'stop',
							usage: responseUsage(
								event.response.usage ?? {},
								(event.response as { service_tier?: unknown }).service_tier,
								requestedSpeed,
							),
							replayState,
						}
						break
					}
					case 'response.incomplete': {
						// The backend stopped the response early: its output budget or
						// a content filter. This event was not handled, so the stream
						// just ended with no finish reason — a length cut looked like
						// a dropped connection, auto-continuation never fired, and a
						// tool call it cut off could not be told from one it did not.
						// No replay state: the items are unfinished, and the message
						// is replayed from its content instead.
						const reason = event.response.incomplete_details?.reason
						finished = true
						yield {
							id: event.response.id,
							delta: {},
							finishReason: reason === 'content_filter' ? 'content_filter' : 'length',
							...(reason === 'content_filter' ? { refusal: {} } : {}),
							usage: responseUsage(
								event.response.usage ?? {},
								(event.response as { service_tier?: unknown }).service_tier,
								requestedSpeed,
							),
						}
						break
					}
					case 'error':
					case 'response.failed':
						throw new ProviderRequestError({
							kind: 'server',
							providerId: this.id,
							detail: 'the Codex Responses stream failed',
						})
				}
			}
			if (!finished) {
				throw new ProviderRequestError({
					kind: 'network',
					providerId: this.id,
					detail: 'the connection closed before the response finished',
				})
			}
		} catch (error) {
			if (isCallerAbortError(error, params.signal)) throw params.signal?.reason ?? error
			if (isProviderRequestError(error)) throw error
			throw providerVendorError({ providerId: this.id, error })
		}
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		signal?.throwIfAborted()
		const response = (await this.client.get('/models?client_version=1.0.0', {
			signal,
		})) as { models?: unknown }
		signal?.throwIfAborted()
		const profiles = new Map<string, SubscriptionReasoningProfile>()
		const tiersBySlug = new Map<string, readonly FastTier[]>()
		const windows = new Map<string, number>()
		const models = (Array.isArray(response.models) ? response.models : []).flatMap(
			(value): ModelInfo[] => {
				const item = record(value)
				if (typeof item?.slug !== 'string' || item.slug.length === 0) return []
				if (item.visibility === 'hide' || item.visibility === 'hidden') return []
				const profile = subscriptionReasoningProfile(item)
				if (profile) profiles.set(item.slug.toLowerCase(), profile)
				const speedTiers = subscriptionSpeedTiers(item)
				tiersBySlug.set(item.slug.toLowerCase(), speedTiers)
				const stated = declaredContextWindow(item)
				const contextWindow =
					stated === undefined
						? undefined
						: Math.max(1, Math.floor(stated * (effectiveWindowFraction(item) ?? 1)))
				if (contextWindow !== undefined) windows.set(item.slug.toLowerCase(), contextWindow)
				return [
					{
						id: item.slug,
						name: typeof item.display_name === 'string' ? item.display_name : item.slug,
						supportsToolUse: true,
						supportsStreaming: true,
						...(profile ? { reasoningEffortLevels: profile.levels } : {}),
						...(profile?.default !== undefined ? { reasoningEffortDefault: profile.default } : {}),
						speedTiers,
						...(contextWindow !== undefined ? { contextWindow } : {}),
					},
				]
			},
		)
		this.reasoningProfiles = profiles
		this.speedTiers = tiersBySlug
		this.windows = windows
		listingByAccount.set(this.listingKey, {
			speedTiers: tiersBySlug,
			reasoningProfiles: profiles,
			windows,
		})
		return models
	}

	async probeCredential(signal?: AbortSignal): Promise<void> {
		await this.listModels(signal)
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.probeCredential()
			return true
		} catch {
			return false
		}
	}
}

/**
 * What a hosted search call says about itself: its query, or the page it
 * opened, and how many sources it listed. Read defensively — the item on
 * `output_item.added` routinely has no action yet, and a field the service
 * leaves out stays absent rather than becoming an empty string or a zero.
 */
export function webSearchDetail(item: {
	readonly action?: unknown
}): { query?: string; url?: string; results?: number; searches?: number } {
	const action = item.action as
		| {
				readonly type?: unknown
				readonly query?: unknown
				readonly queries?: unknown
				readonly sources?: unknown
				readonly url?: unknown
		  }
		| null
		| undefined
	if (!action || typeof action !== 'object') return {}
	const queries = Array.isArray(action.queries)
		? action.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
		: []
	const query =
		typeof action.query === 'string' && action.query.trim().length > 0
			? action.query.trim()
			: queries[0]?.trim()
	const url = typeof action.url === 'string' && action.url.length > 0 ? action.url : undefined
	return {
		...(query ? { query } : {}),
		...(url && !query ? { url } : {}),
		...(Array.isArray(action.sources) ? { results: action.sources.length } : {}),
		// One hosted item may run several queries; the count says so, the label names the first.
		...(queries.length > 1 ? { searches: queries.length } : {}),
	}
}
