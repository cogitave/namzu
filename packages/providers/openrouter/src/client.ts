import type {
	ChatCompletionParams,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	ProviderRoute,
	ReasoningBlock,
	ReasoningEffort,
	StreamChunk,
	ThinkingConfig,
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
import type { Logger } from '@namzu/sdk'
import { NOOP_LOGGER } from '@namzu/sdk'
import type { OpenRouterConfig } from './types.js'

/**
 * The words a proxied backend's own `native_finish_reason` uses for "the
 * model's context window, not its output-token budget, is what ran out" —
 * the same vocabulary `@namzu/http`'s `mapOpenAIFinish` reads from an
 * OpenAI-compatible dialect, since OpenRouter's backends speak in exactly
 * those dialects underneath its own normalisation.
 */
const CONTEXT_WINDOW_NATIVE_REASONS = new Set([
	'model_context_window_exceeded',
	'model_length',
	'context_length',
	'context_length_exceeded',
])

/**
 * OpenRouter's normalised `finish_reason`, as the finish fields of a stream
 * chunk: `finishReason`, and `finishDetail: 'context_window'` when a
 * `'length'` finish was the model's context window.
 *
 * `finish_reason` used to be cast straight through. `error` — the upstream
 * failed mid-generation — then reached the runtime as a finish reason
 * outside its union, and a tool call the failure cut off read as one the
 * model had finished and got wrong. It is a failure, and is thrown as one.
 *
 * OpenRouter collapses every backend's own reason into one of five, so a
 * proxied Anthropic model's context window and a proxied OpenAI model's
 * output limit both arrive here as plain `'length'` — exactly the fold that
 * made an lmstudio and http response cut off by its context window get
 * auto-continued into a prompt longer than the window it had just filled.
 * `native_finish_reason` carries the backend's own word for it verbatim
 * (OpenRouter's API reference calls it "the raw finish_reason from the
 * provider"), and is read here only to recover that one distinction.
 */
function mapFinishReason(
	reason: string | null | undefined,
	nativeReason: string | null | undefined,
): Pick<StreamChunk, 'finishReason' | 'finishDetail' | 'refusal'> {
	switch (reason) {
		case null:
		case undefined:
		case '':
			return {}
		case 'length':
			return nativeReason && CONTEXT_WINDOW_NATIVE_REASONS.has(nativeReason)
				? { finishReason: 'length', finishDetail: 'context_window' }
				: { finishReason: 'length' }
		case 'tool_calls':
		case 'function_call':
			return { finishReason: 'tool_calls' }
		case 'content_filter':
			return { finishReason: 'content_filter', refusal: {} }
		case 'error':
			throw new ProviderRequestError({
				kind: 'server',
				providerId: 'openrouter',
				detail: 'the upstream model failed while generating',
			})
		default:
			return { finishReason: 'stop' }
	}
}

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
 * is (verified against
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

function routeOf(params: ChatCompletionParams): ProviderRoute {
	return params.providerRoute ?? { providerId: 'openrouter', model: params.model, chainIndex: 0 }
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
	/** USD charged to the account for this request. Present on every response. */
	cost?: number | null
	/** Bring-your-own-key: the upstream bills the caller directly, `cost` is only OpenRouter's part. */
	is_byok?: boolean
	cost_details?: { upstream_inference_cost?: number | null }
}

/**
 * What the request cost, as OpenRouter reports it, or `undefined`.
 *
 * `usage.cost` is "the total charged to your account", on every response
 * without being asked (the documented `usage: { include: true }` is now a
 * no-op, so this driver does not send it). A request on the caller's own
 * upstream key (BYOK) is billed twice over: the upstream bills the caller
 * directly and `cost` is only OpenRouter's share, so the upstream figure the
 * response also carries is added, or the report would understate what the
 * person spent. A missing, null or non-numeric `cost` is "not reported", never
 * zero; a reported `0` (a free model) is a real zero.
 */
function reportedCost(raw: RawUsage): number | undefined {
	const charged = raw.cost
	if (typeof charged !== 'number' || !Number.isFinite(charged) || charged < 0) return undefined
	const upstream = raw.cost_details?.upstream_inference_cost
	return raw.is_byok === true && typeof upstream === 'number' && Number.isFinite(upstream)
		? charged + Math.max(0, upstream)
		: charged
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
	const cost = reportedCost(raw)
	return {
		promptTokens: raw.prompt_tokens,
		completionTokens: raw.completion_tokens,
		totalTokens: raw.total_tokens,
		cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? 0,
		cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
		...(cost !== undefined ? { reportedCostUsd: cost } : {}),
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
 * Adapter-private state for one completed reasoning response.
 *
 * OpenRouter's guide for reasoning across tool calls says to send the
 * assistant message back with its `reasoning_details` unmodified: the whole
 * sequence of blocks, in the order the model produced it. The kernel's own
 * reasoning blocks keep the text, signature and encrypted payload but not the
 * rest of each entry (its `format`, `id`, summary form), so the entries as the
 * wire sent them are kept here, in the message's source, and the route is
 * repeated inside so the state is used only by the member that produced it.
 *
 * `reasoning` is the flat string of a route that sent no `reasoning_details`.
 */
interface OpenRouterReplayState {
	readonly kind: 'namzu-openrouter-reasoning'
	readonly version: 1
	readonly route: ProviderRoute
	readonly details?: readonly Record<string, unknown>[]
	readonly reasoning?: string
}

function sameRoute(left: ProviderRoute, right: ProviderRoute): boolean {
	return (
		left.providerId === right.providerId &&
		left.model === right.model &&
		left.chainIndex === right.chainIndex
	)
}

function isReplayState(value: unknown): value is OpenRouterReplayState {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const state = value as Record<string, unknown>
	const route = state.route as Record<string, unknown> | null | undefined
	if (
		state.kind !== 'namzu-openrouter-reasoning' ||
		state.version !== 1 ||
		typeof route !== 'object' ||
		route === null ||
		typeof route.providerId !== 'string' ||
		typeof route.model !== 'string' ||
		!Number.isSafeInteger(route.chainIndex)
	) {
		return false
	}
	const hasDetails =
		Array.isArray(state.details) &&
		state.details.length > 0 &&
		state.details.every((d) => typeof d === 'object' && d !== null && !Array.isArray(d))
	const hasFlat = typeof state.reasoning === 'string' && state.reasoning.length > 0
	return hasDetails !== hasFlat
}

/**
 * Fold the `reasoning_details` fragments of a stream into the entries the
 * complete response held: fragments of one `index` are one entry, its text
 * (or summary, or encrypted data) concatenated in arrival order, every other
 * field kept as first sent and a signature kept when one arrives.
 */
class ReasoningDetailsAccumulator {
	private readonly entries = new Map<number, Record<string, unknown>>()
	private flat = ''

	addFlat(text: string | null | undefined): void {
		if (typeof text === 'string') this.flat += text
	}

	add(fragments: readonly RawReasoningDetail[] | undefined): void {
		for (const [position, fragment] of (fragments ?? []).entries()) {
			if (typeof fragment !== 'object' || fragment === null) continue
			const raw = fragment as Record<string, unknown>
			const index = typeof raw.index === 'number' ? raw.index : position
			const entry = this.entries.get(index)
			if (!entry) {
				this.entries.set(index, { ...raw })
				continue
			}
			for (const [key, value] of Object.entries(raw)) {
				if (key === 'text' || key === 'summary' || key === 'data') {
					if (typeof value === 'string') {
						entry[key] = (typeof entry[key] === 'string' ? entry[key] : '') + value
					}
				} else if (key === 'signature') {
					if (typeof value === 'string' && value.length > 0) entry[key] = value
				} else if (entry[key] === undefined) {
					entry[key] = value
				}
			}
		}
	}

	get hasAny(): boolean {
		return this.entries.size > 0 || this.flat.length > 0
	}

	state(route: ProviderRoute): OpenRouterReplayState | undefined {
		if (this.entries.size > 0) {
			const details = [...this.entries.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
			return { kind: 'namzu-openrouter-reasoning', version: 1, route, details }
		}
		return this.flat.length > 0
			? { kind: 'namzu-openrouter-reasoning', version: 1, route, reasoning: this.flat }
			: undefined
	}
}

/** The text and the opaque payloads the kernel's own blocks would hold for a state. */
function durableFingerprint(state: OpenRouterReplayState): string {
	if (state.details === undefined) return JSON.stringify([state.reasoning, ''])
	let text = ''
	let encrypted = ''
	for (const d of state.details) {
		if (d.type === 'reasoning.encrypted') {
			if (typeof d.data === 'string') encrypted += d.data
		} else if (typeof d.text === 'string') {
			text += d.text
		}
	}
	return JSON.stringify([text, encrypted])
}

function blocksFingerprint(blocks: readonly ReasoningBlock[] | undefined): string {
	let text = ''
	let encrypted = ''
	for (const b of blocks ?? []) {
		if (b.type === 'redacted_thinking') encrypted += b.encrypted ?? ''
		else text += b.text ?? ''
	}
	return JSON.stringify([text, encrypted])
}

/**
 * The reasoning to send back with an assistant message, or nothing.
 *
 * Only from a validated envelope of the same route whose content still matches
 * the stored reasoning (request repair or compaction that rewrote the blocks
 * leaves the envelope behind, and a mismatch means history-neutral). Names
 * alone never prove it.
 */
function replayFor(
	message: Extract<ChatCompletionParams['messages'][number], { role: 'assistant' }>,
	target: ProviderRoute,
): { reasoning_details: readonly Record<string, unknown>[] } | { reasoning: string } | undefined {
	const source = message.source
	if (!source || source.type !== 'model' || !sameRoute(source, target)) return undefined
	const state = source.replayState
	if (!isReplayState(state) || !sameRoute(state.route, target)) return undefined
	if (durableFingerprint(state) !== blocksFingerprint(message.reasoning)) return undefined
	return state.details !== undefined
		? { reasoning_details: state.details }
		: { reasoning: state.reasoning as string }
}

/**
 * Index of the first message of the current turn: the last user message that
 * is not host-generated context. Reasoning is sent back for the assistant
 * messages from there on, which is what the guide asks for between a tool
 * call and the model's next step; an earlier turn is history and is not
 * resent. Answers 0 when the conversation holds no such user message.
 */
function currentTurnStart(messages: ChatCompletionParams['messages']): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg?.role === 'user' && msg.source?.type !== 'runtime-context') return i
	}
	return 0
}

/**
 * Whether a model is one whose vendor refuses a forced tool choice while it
 * reasons: the DeepSeek V4 generation and its reasoner line. Its own API
 * answers 400 "Thinking mode does not support this tool_choice". Matched on
 * the id's bare name (a `deepseek/` prefix, an OpenRouter `~` alias marker and a
 * `:tag` removed), never by substring, so a derivative is not swept in.
 */
function refusesForcedChoiceWhileReasoning(model: string): boolean {
	const afterSlash = model.replace(/^~/, '').toLowerCase()
	const bare = afterSlash.slice(afterSlash.lastIndexOf('/') + 1).split(':')[0] ?? ''
	return /^deepseek-(v([4-9]|\d{2,})(\.|-|$)|r\d+(-|$)|reasoner(-|$)|(flash|pro)(-|$))/.test(bare)
}

/** Highest first. What a request for `max` or `ultra` falls down through. */
const EFFORT_DESCENDING = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'] as const

/**
 * The level that stands in for an SDK effort the wire may not carry.
 *
 * `max` and `ultra` are legal SDK values, so refusing them stopped a run for a
 * setting nobody did wrong. Each asks for the deepest reasoning the model
 * offers, so each resolves to the highest level in the model's own list
 * (`supported_efforts` in the `/models` listing), never `none`. When the
 * listing could not be read or does not carry a list for the model, the
 * highest level the unified `reasoning.effort` documents for every model, `xhigh`, is sent: a level the
 * vendor accepts, one step short of what was asked for rather than a failure.
 * Every other level is sent as given.
 */
function carriedEffort(
	effort: NonNullable<ChatCompletionParams['effort']>,
	supported: readonly string[] | undefined,
): string {
	if (effort !== 'max' && effort !== 'ultra') return effort
	if (!supported) return 'xhigh'
	return EFFORT_DESCENDING.find((level) => supported.includes(level)) ?? 'xhigh'
}

/**
 * Map the SDK's thinking controls onto OpenRouter's unified `reasoning` object.
 *
 * `undefined` means "say nothing", which leaves the vendor's own default in
 * place — the only correct answer for a driver that was asked for nothing.
 */
function formatReasoning(
	thinking: ChatCompletionParams['thinking'],
	effort: string | undefined,
): Record<string, unknown> | undefined {
	if (effort !== undefined) return { effort }
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

/** A choice that makes the model call a tool: `required` or a named function. */
function isForcedToolChoice(tc: ToolChoice): boolean {
	return tc !== 'auto' && tc !== 'none'
}

/**
 * Whether a 400 body is the vendor refusing the tool choice. The router passes
 * the upstream sentence through ("Thinking mode does not support this
 * tool_choice"), so the field name is what identifies it.
 */
function refusesToolChoice(errorBody: string): boolean {
	return /tool_choice/i.test(errorBody)
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
	// OpenRouter states the charge on every response (`usage.cost`).
	reportsRequestCost: true,
}

export class OpenRouterProvider implements LLMProvider {
	readonly id = 'openrouter'
	readonly name = 'OpenRouter'
	readonly capabilities = OPENROUTER_CAPABILITIES

	private config: OpenRouterConfig
	private baseUrl: string
	private logger: Logger

	constructor(config: OpenRouterConfig) {
		if (!config.apiKey) {
			throw new Error('OpenRouter API key is required. Set OPENROUTER_API_KEY env variable.')
		}
		this.config = config
		this.baseUrl = config.baseUrl ?? OPENROUTER_BASE_URL
		this.logger = config.logger ?? NOOP_LOGGER
	}

	/**
	 * Whether a forced tool choice (`required` or a named function) is taken
	 * under the thinking configuration the request will carry. `false` only for
	 * the DeepSeek models whose own API refuses it while they reason, and
	 * reasoning is on for them unless thinking is disabled or effort is `none`
	 * (the same rule the DeepSeek driver applies). The kernel asks first and,
	 * on `false`, keeps the step at low effort and asks in words.
	 *
	 * The vendor's refusal is not what every route returns. On the live route a
	 * forced choice with reasoning on was served (HTTP 200) by five different
	 * upstream hosts, and when the request was pinned to the vendor's own host
	 * the router answered its own 404 "no endpoints" (its tool-compatibility
	 * filter drops that host for a forced choice). Yet a real session got the
	 * vendor's own 400 "Thinking mode does not support this tool_choice" from
	 * some host. So this driver acts on both facts: where this answer is
	 * `false` the forced choice is not put on the wire, and a request that did
	 * carry one and drew a 400 naming `tool_choice` is sent once more without
	 * it. A host that accepts the choice keeps getting it; only a host that
	 * rejects it costs a second request.
	 */
	acceptsForcedToolChoiceFor(
		model: string,
		thinking?: ThinkingConfig,
		effort?: ReasoningEffort,
	): boolean {
		if (!refusesForcedChoiceWhileReasoning(model)) return true
		return thinking?.type === 'disabled' || effort === 'none'
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

	private formatMessages(
		messages: ChatCompletionParams['messages'],
		route: ProviderRoute,
	): unknown[] {
		const turnStart = currentTurnStart(messages)
		// An assistant entry with neither text nor a tool call (the model produced
		// only reasoning, or was cut off) is rejected upstream with "content or
		// tool_calls must be set". Leave it out; no filler is invented. An entry
		// with tool calls is never dropped, so every tool result still follows the
		// call it answers, and the stored history is untouched.
		const sendable = messages
			.map((msg, index) => ({ msg, index }))
			.filter(
				({ msg }) =>
					msg.role !== 'assistant' || Boolean(msg.content) || (msg.toolCalls?.length ?? 0) > 0,
			)
		return sendable.map(({ msg, index }) => {
			if (msg.role === 'tool') {
				return {
					role: 'tool',
					content: msg.content,
					tool_call_id: (msg as { toolCallId?: string }).toolCallId,
				}
			}
			// The model's own reasoning for the steps of THIS turn goes back with the
			// message that produced it, so it can continue from where it left off
			// after a tool result. An earlier turn's reasoning is not resent.
			const replay =
				msg.role === 'assistant' && index >= turnStart ? replayFor(msg, route) : undefined
			if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls?.length) {
				return {
					role: 'assistant',
					content: msg.content,
					tool_calls: msg.toolCalls.map((tc) => ({
						id: tc.id,
						type: tc.type,
						function: tc.function,
					})),
					...replay,
				}
			}
			return { role: msg.role, content: msg.content, ...replay }
		})
	}

	private buildRequestBody(
		params: ChatCompletionParams,
		stream: boolean,
		supportedEfforts?: readonly string[],
	): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model: params.model,
			messages: this.formatMessages(params.messages, routeOf(params)),
			stream,
		}

		if (params.tools && params.tools.length > 0) {
			body.tools = params.tools
		}
		if (params.toolChoice !== undefined) {
			if (
				isForcedToolChoice(params.toolChoice) &&
				!this.acceptsForcedToolChoiceFor(params.model, params.thinking, params.effort)
			) {
				// The model's vendor refuses a forced choice while it reasons. Not
				// sending it costs the caller nothing it could have had: the step
				// goes out with the choice left to the model.
				this.logger.debug('openrouter: forced tool_choice not sent, the model refuses it here', {
					'namzu.model': params.model,
				})
			} else {
				body.tool_choice = formatToolChoice(params.toolChoice)
			}
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

		// `max` and `ultra` resolve against the model's own list — see
		// `carriedEffort`.
		const reasoning = formatReasoning(
			params.thinking,
			params.effort !== undefined ? carriedEffort(params.effort, supportedEfforts) : undefined,
		)
		if (reasoning !== undefined) {
			body.reasoning = reasoning
		}

		if (params.responseFormat) {
			body.response_format = params.responseFormat
		}

		return body
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const supportedEfforts =
			params.effort === 'max' || params.effort === 'ultra'
				? await this.resolveSupportedEfforts(params.model, params.signal)
				: undefined
		const body = this.buildRequestBody(params, true, supportedEfforts)

		const timeout = AbortSignal.timeout(this.config.timeout ?? 120_000)
		// Compose the caller abort with the request timeout so a Stop cancels the
		// response body stream. When no caller signal is present this is the exact
		// prior `AbortSignal.timeout(...)` expression (byte-identical).
		const signal = params.signal ? AbortSignal.any([timeout, params.signal]) : timeout

		const send = async (payload: Record<string, unknown>): Promise<Response> => {
			try {
				return await fetch(`${this.baseUrl}/chat/completions`, {
					method: 'POST',
					headers: this.getHeaders(),
					body: JSON.stringify(payload),
					signal,
				})
			} catch (err) {
				if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
				throw providerVendorError({ providerId: 'openrouter', error: err })
			}
		}

		let response = await send(body)

		if (!response.ok) {
			// The body is read to CLASSIFY (a 400 saying "prompt is too long" is a
			// context overflow, any other 400 is a bad request) and then dropped. It
			// used to be interpolated straight into the message, which is how a
			// credential the upstream echoed back reached every log that recorded
			// the failure — proven with a planted fake token.
			let errorBody = await response.text().catch(() => '')
			const sentForced =
				body.tool_choice !== undefined && isForcedToolChoice(body.tool_choice as ToolChoice)
			if (response.status === 400 && sentForced && refusesToolChoice(errorBody)) {
				// This host refuses a forced choice. Ask once more without it; the
				// model decides whether to call a tool. Anything the second attempt
				// answers is final.
				this.logger.debug('openrouter: a 400 named tool_choice, sending once more without it', {
					'namzu.model': params.model,
				})
				const { tool_choice: _dropped, ...withoutChoice } = body
				response = await send(withoutChoice)
				if (!response.ok) errorBody = await response.text().catch(() => '')
			}
			if (!response.ok) {
				throw providerHttpError({
					providerId: 'openrouter',
					status: response.status,
					body: errorBody,
					retryAfter: response.headers.get('retry-after'),
					shouldRetry: response.headers.get('x-should-retry'),
				})
			}
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
		// The reasoning entries as the wire sent them, kept for replay.
		const replay = new ReasoningDetailsAccumulator()
		const route = routeOf(params)
		let replayStateEmitted = false
		// A choice reported why it stopped. A stream that ends without one, with or
		// without `[DONE]`, was cut by the connection.
		let finished = false
		const cutShort = () =>
			new ProviderRequestError({
				kind: 'network',
				providerId: 'openrouter',
				detail: 'the connection closed before the response finished',
			})

		try {
			while (true) {
				params.signal?.throwIfAborted()
				const { done, value } = await reader.read()
				if (done) {
					if (!finished) throw cutShort()
					break
				}

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split('\n')
				buffer = lines.pop() ?? ''

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || !trimmed.startsWith('data: ')) continue
					const data = trimmed.slice(6)
					if (data === '[DONE]') {
						if (!finished) throw cutShort()
						return
					}

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
								finish_reason?: string | null
								native_finish_reason?: string | null
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
						if (choice.finish_reason) finished = true

						const fragments = parseReasoning(choice.delta.reasoning_details, choice.delta.reasoning)
						if (choice.delta.reasoning_details && choice.delta.reasoning_details.length > 0) {
							replay.add(choice.delta.reasoning_details)
						} else {
							replay.addFlat(choice.delta.reasoning)
						}
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
							const replayState =
								!replayStateEmitted && choice.finish_reason && replay.hasAny
									? replay.state(route)
									: undefined
							if (replayState !== undefined) replayStateEmitted = true
							yield {
								id: parsed.id,
								...(replayState !== undefined ? { replayState } : {}),
								delta: {
									...(firstFragment ? { reasoning: firstFragment } : {}),
									content,
									toolCalls,
								},
								...mapFinishReason(choice.finish_reason, choice.native_finish_reason),
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
		// A variant tag (`:batch`, `:nitro`) names the same model at the same
		// window; when the listing has only the untagged id, that is the answer.
		const tag = model.indexOf(':')
		const reported = windows.get(model) ?? (tag > 0 ? windows.get(model.slice(0, tag)) : undefined)
		return typeof reported === 'number' && reported > 0 ? reported : undefined
	}

	/**
	 * The reasoning levels the listing names for `model` (`reasoning.supported_efforts`),
	 * or `undefined` when the listing cannot be read or names none. Read only
	 * for a `max` or `ultra` request, and kept for this driver once fulfilled; a
	 * failure is not kept. A caller abort still propagates.
	 */
	private async resolveSupportedEfforts(
		model: string,
		signal?: AbortSignal,
	): Promise<readonly string[] | undefined> {
		let table = this.supportedEfforts
		if (!table) {
			try {
				signal?.throwIfAborted()
				const response = await fetch(`${this.baseUrl}/models`, {
					headers: this.getHeaders(),
					...(signal ? { signal } : {}),
				})
				if (!response.ok) return undefined
				const data = (await response.json()) as {
					data?: Array<{ id: string; reasoning?: { supported_efforts?: unknown } }>
				}
				table = new Map()
				for (const m of data.data ?? []) {
					const levels = m.reasoning?.supported_efforts
					if (Array.isArray(levels)) {
						table.set(
							m.id,
							levels.filter((l): l is string => typeof l === 'string'),
						)
					}
				}
				this.supportedEfforts = table
			} catch (err) {
				if (signal?.aborted) throw signal.reason ?? err
				return undefined
			}
		}
		const tag = model.indexOf(':')
		return table.get(model) ?? (tag > 0 ? table.get(model.slice(0, tag)) : undefined)
	}

	private supportedEfforts?: Map<string, string[]>

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
