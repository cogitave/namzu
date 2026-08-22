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
	inputPrice: number
	outputPrice: number
	supportsToolUse: boolean
	supportsStreaming: boolean
}
