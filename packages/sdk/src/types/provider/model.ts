export interface ModelInfo {
	id: string
	name: string
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
