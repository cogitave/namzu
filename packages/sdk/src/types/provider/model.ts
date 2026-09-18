/** A kind of input a model is known to accept. */
export type ModelInputModality = 'text' | 'image' | 'document'

export interface ModelInfo {
	id: string
	name: string
	/**
	 * Input kinds this exact model is known to accept.
	 *
	 * This is model metadata, not a replacement for
	 * `LLMProvider.capabilities`: the provider capability says whether the
	 * DRIVER can map an input kind at all, while this field says which models
	 * behind that driver accept it. Absent means the listing did not establish
	 * the answer; it must not be read as text-only.
	 */
	inputModalities?: readonly ModelInputModality[]
	/** Exact selectable effort levels for this model and route. Absent means unknown; [] means unsupported. */
	reasoningEffortLevels?: readonly import('./chat.js').ReasoningEffort[]
	/** Published default, when established; must belong to reasoningEffortLevels when both are present. */
	reasoningEffortDefault?: import('./chat.js').ReasoningEffort
	/**
	 * Tokens the model's context holds, when the driver knows.
	 *
	 * OPTIONAL, and the optionality is the fix. Four drivers filled this
	 * with `0` where the vendor listing carries no value — and zero is not
	 * a window, it is "I do not know" written as a number, which reads to
	 * every consumer as a real measurement of a model that can hold
	 * nothing. A caller dividing by it gets `Infinity`; one comparing
	 * against it concludes every prompt is too long.
	 *
	 * Absent says the same thing honestly, and a consumer can then fall
	 * back to its own table instead of trusting a zero.
	 */
	contextWindow?: number
	/** Same, and absent for the same reason. */
	maxOutputTokens?: number
	/**
	 * USD per million input tokens, when the driver knows the rate.
	 *
	 * OPTIONAL, and the optionality is the fix — the same one `contextWindow`
	 * got, applied to the field where a zero is most expensive. Six drivers
	 * wrote `0` wherever the vendor listing carries no rate, and a price of
	 * zero is not "I do not know", it is a billing fact: "this model is
	 * free". A consumer summing these under-reports a bill; one offering a
	 * `(free)` marker — the read that found this — labels every paid model
	 * on a driver that never learned its rates.
	 *
	 * The distinction is not new here, only lost in transit.
	 * `resolveModelPricing` already returns `undefined` for a rate nobody
	 * has and `{0, 0}` for a driver that genuinely bills nothing, and says
	 * in as many words that a caller flattening the two reproduces the
	 * defect the pricing module exists to remove. This field carried the
	 * flattened version to every consumer that never reached that module.
	 *
	 * Absent means unknown. `0` means free, and is only written by a driver
	 * that knows it: the local servers, and a catalogue whose source names
	 * the model as free. A caller that must show a number should render
	 * "unknown" rather than `$0.00`, which is the conclusion being fixed.
	 */
	inputPrice?: number
	/** Same, and absent for the same reason. */
	outputPrice?: number
	supportsToolUse: boolean
	supportsStreaming: boolean
}
