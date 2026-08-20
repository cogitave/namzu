import type { TokenUsage } from '../common/index.js'
import type { Message, ReasoningBlock, ToolCall } from '../message/index.js'
import type { LLMToolSchema } from '../tool/index.js'

export type ToolChoice =
	| 'auto'
	| 'none'
	| 'required'
	| { type: 'function'; function: { name: string } }

export type ResponseFormat =
	| { type: 'json_object' }
	| {
			type: 'json_schema'
			json_schema: {
				name: string
				schema: Record<string, unknown>
				strict?: boolean
			}
	  }

export interface CacheControl {
	type: 'auto' | 'ephemeral'
}

export interface ChatCompletionParams {
	model: string
	messages: Message[]
	tools?: LLMToolSchema[]
	/**
	 * Provider hint naming tools whose model-facing JSON Schema should be
	 * enforced through constrained generation when the selected transport and
	 * model support it.
	 *
	 * This is not a wire field. Provider implementations must consume or omit
	 * it instead of serializing ChatCompletionParams wholesale.
	 */
	enforceToolInputSchema?: readonly string[]
	temperature?: number
	maxTokens?: number
	stream?: boolean
	stop?: string[]

	/**
	 * Per-call cancellation. Aborting it tears down the in-flight model
	 * request (the provider passes it to the underlying fetch / SDK) AND the
	 * runtime races the stream consumer against it, so a Stop stops the
	 * CURRENT turn mid-flight — not only between turns. Optional and inert
	 * when unset: a non-aborted signal is behaviourally identical to omitting
	 * it, so existing callers are unaffected.
	 */
	signal?: AbortSignal

	toolChoice?: ToolChoice
	parallelToolCalls?: boolean

	cacheControl?: CacheControl

	topP?: number
	topK?: number
	frequencyPenalty?: number
	presencePenalty?: number
	repetitionPenalty?: number

	responseFormat?: ResponseFormat

	/**
	 * Extended-thinking request.
	 *
	 * Absent from this struct entirely before, and `buildCreateParams`
	 * assembles the request body key-by-key with no passthrough, so
	 * thinking could not be *requested* — while on models where it is on by
	 * default the runtime received blocks it then discarded. Neither half
	 * was expressible.
	 *
	 * A driver that has no extended-thinking wire must refuse `enabled` and
	 * `adaptive` rather than return an ordinary answer that looks honoured.
	 * `disabled` may be accepted as an explicit no-op by a driver that was
	 * already going to leave thinking off.
	 */
	thinking?: ThinkingConfig

	/**
	 * How much work to put into the response. See {@link ReasoningEffort}.
	 *
	 * A driver with no effort concept must refuse the field rather than silently
	 * use the model default. Drivers whose accepted levels vary by model resolve
	 * that narrower set according to their documented provider policy.
	 */
	effort?: ReasoningEffort
}

export interface ThinkingConfig {
	/**
	 * Which thinking mode to ask for.
	 *
	 * `'adaptive'` lets the model decide whether and how deeply to think per
	 * request; depth is steered by {@link ChatCompletionParams.effort} rather
	 * than a token budget. `'enabled'` is the older manual mode, where
	 * {@link budgetTokens} fixes the depth and the model thinks on every
	 * request.
	 *
	 * **These are not interchangeable, and a driver must not guess.** Vendors
	 * reject the wrong one for a given model outright rather than degrading:
	 * newer models refuse `'enabled'`, older ones refuse `'adaptive'`, and
	 * some refuse `'disabled'` because they cannot stop thinking at all. A
	 * driver that sends a mode the model does not accept produces a failed
	 * request, not a worse answer — which is why this is a declared intent
	 * that each driver resolves against the model it is about to call.
	 */
	type: 'adaptive' | 'enabled' | 'disabled'

	/**
	 * Token allowance for the thinking pass. Manual mode only — the adaptive
	 * mode has no budget, and depth is set by `effort`.
	 */
	budgetTokens?: number

	/**
	 * Whether the thinking text comes back or only its signature.
	 *
	 * `'omitted'` returns the blocks with an empty body and a signature, which
	 * is enough to replay them on the next turn (see `replayReasoning`) while
	 * keeping the text out of the response. `'summarized'` returns a summary
	 * of the reasoning.
	 *
	 * Worth setting explicitly. This defaults to `'omitted'` on newer models,
	 * so a caller that wants to show reasoning and does not ask for it gets
	 * thinking blocks whose text is empty and no indication why.
	 *
	 * The values were `'full' | 'summarized'` here, and `'full'` was never a
	 * value any vendor accepted — a declared option that could only ever have
	 * been rejected, next to a real one that was missing.
	 */
	display?: 'summarized' | 'omitted'
}

/**
 * How much work the model should put into a response.
 *
 * A sibling of {@link ChatCompletionParams.thinking}, not a field inside it,
 * because it is not exclusively a thinking control: it shapes the whole
 * response, and at least one manual-mode model accepts it alongside a token
 * budget, where effort shapes the answer and the budget sets thinking depth.
 * Nesting it under `thinking` would have made that combination unsayable.
 *
 * In adaptive mode it is the primary depth lever — low effort may skip
 * thinking entirely on easy input. In manual mode `budgetTokens` sets depth
 * and effort does not move it.
 *
 * This union describes caller intent, not a claim that every provider or model
 * accepts every level. For example, `minimal` and `none` are distinct levels on
 * different compatible model generations, `max` is available only on newer
 * families, and `ultra` can be a host-level value rather than a model wire
 * capability. A provider must resolve the selected model's actual set before
 * transport or leave the vendor to refuse an unknown compatible-endpoint
 * extension explicitly.
 */
export type ReasoningEffort =
	| 'none'
	| 'minimal'
	| 'low'
	| 'medium'
	| 'high'
	| 'xhigh'
	| 'max'
	| 'ultra'

export interface ChatCompletionResponse {
	id: string
	model: string
	message: {
		role: 'assistant'
		content: string | null
		toolCalls?: ToolCall[]
		/** Reasoning blocks the model emitted, in original block order. */
		reasoning?: readonly ReasoningBlock[]
		/** Passages this turn cites, in the order the model made them. */
		citations?: readonly import('../message/index.js').Citation[]
	}
	finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
	usage: TokenUsage
}
