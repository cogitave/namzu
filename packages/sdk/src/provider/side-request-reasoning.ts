import type {
	ChatCompletionParams,
	LLMProvider,
	ReasoningEffort,
	StreamChunk,
	ThinkingConfig,
} from '../types/provider/index.js'

/**
 * Room added to a side request's answer allowance when the provider could not
 * promise that reasoning is off. A thinking model spends tokens on reasoning
 * before the first word of the answer, and a small answer allowance is gone by
 * then: the reply is cut off with nothing in it.
 */
export const SIDE_REQUEST_REASONING_HEADROOM = 2048

const DISABLED: ThinkingConfig = { type: 'disabled' }

/** Efforts a driver may offer for "as little as possible", cheapest first. */
const LOWEST_FIRST: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium']

/** The request fields a side request sets: thinking, effort and the answer allowance. */
export type SideReasoningFields = Pick<ChatCompletionParams, 'thinking' | 'effort' | 'maxTokens'>

/**
 * The reasoning settings for a small request made beside a turn (a lookup, a
 * label, a title, a classifier): ask the provider for no reasoning where it can
 * switch it off for one request, and where it cannot, leave room in the answer
 * allowance for the reasoning it will spend.
 *
 * The turn's own thinking and effort are never inherited: a side request is not
 * the turn, and a high effort chosen for the turn's work would starve a
 * 60-token label. The turn's own requests are not touched by this.
 *
 * Each driver answers through `reasoningEffortLevelsFor(model, disabled)`:
 * - a list that holds `none`: send thinking disabled and effort `none`;
 * - a list without `none` (effort is still offered beside a disabled body): send
 *   thinking disabled and the lowest level it offers, and add headroom;
 * - no answer: send thinking disabled, which every driver either carries or
 *   leaves out, and add headroom because nothing confirms it took effect.
 */
export function sideRequestReasoning(
	provider: Pick<LLMProvider, 'reasoningEffortLevelsFor'>,
	model: string,
	maxTokens: number,
): SideReasoningFields {
	let levels: readonly ReasoningEffort[] | undefined
	try {
		levels = provider.reasoningEffortLevelsFor?.(model, DISABLED)
	} catch {
		levels = undefined
	}
	if (levels?.includes('none')) {
		return { thinking: DISABLED, effort: 'none', maxTokens }
	}
	const roomy = maxTokens + SIDE_REQUEST_REASONING_HEADROOM
	if (levels !== undefined && levels.length > 0) {
		const lowest = LOWEST_FIRST.find((level) => levels.includes(level)) ?? levels[0]
		// The levels were asked with thinking disabled, so the driver accepts a
		// disabled body here; send it so reasoning is off, not merely cheap.
		return { thinking: DISABLED, ...(lowest ? { effort: lowest } : {}), maxTokens: roomy }
	}
	return { thinking: DISABLED, maxTokens: roomy }
}

/** A refusal of the reasoning controls themselves, before any output. */
function refusesReasoningControls(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error)
	// An error that merely mentions the words (a rate limit, an overload, a
	// timeout) is not a refusal of the controls: it must neither cost an extra
	// request nor switch the controls off for the model.
	if (/rate.?limit|too many requests|overloaded|timed? ?out|\b(429|5\d\d)\b/i.test(text))
		return false
	const names = /\b(thinking|reasoning|effort)\b/i.test(text)
	const rejects =
		/unsupported|not supported|unsupport|invalid|unknown|unrecogni[sz]ed|unexpected|not allowed|not permitted|does not (?:accept|support|allow)|not accept|extra inputs|bad request|\b400\b|\b422\b/i.test(
			text,
		)
	return names && rejects
}

/**
 * Stream a side request with {@link sideRequestReasoning} applied. A driver that
 * refuses the reasoning controls before sending anything gets the request again
 * without them, at the roomy allowance, and the model is remembered so the next
 * request does not ask again. Any other failure is thrown unchanged.
 */
const noControls = new WeakMap<object, Set<string>>()

export async function* chatStreamForSideRequest(
	provider: LLMProvider,
	params: Omit<ChatCompletionParams, 'thinking' | 'effort'>,
	/** How the request is sent; a caller with its own repair layer passes it. */
	send: (request: ChatCompletionParams) => AsyncIterable<StreamChunk> = (request) =>
		provider.chatStream(request),
): AsyncGenerator<StreamChunk> {
	const base = params.maxTokens ?? 256
	const skip = noControls.get(provider)?.has(params.model) === true
	const fields = sideRequestReasoning(provider, params.model, base)
	const plain: ChatCompletionParams = {
		...params,
		maxTokens: base + SIDE_REQUEST_REASONING_HEADROOM,
	}
	if (skip) {
		yield* send(plain)
		return
	}
	let yielded = false
	try {
		for await (const chunk of send({ ...params, ...fields })) {
			yielded = true
			yield chunk
		}
	} catch (error) {
		if (yielded || params.signal?.aborted || !refusesReasoningControls(error)) throw error
		const seen = noControls.get(provider) ?? new Set<string>()
		seen.add(params.model)
		noControls.set(provider, seen)
		yield* send(plain)
	}
}
