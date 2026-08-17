/**
 * DeepSeek-specific provider config shapes.
 *
 * `DeepSeekConfig` is the constructor input for `DeepSeekProvider` (no
 * discriminator). `DeepSeekProviderConfig` is the shape the consumer passes to
 * `ProviderRegistry.create({ type: 'deepseek', ... })` — it extends
 * `DeepSeekConfig` with the `type: 'deepseek'` discriminator for the registry's
 * generic narrowing.
 */

export interface DeepSeekConfig {
	apiKey: string
	/** Default model. Can be overridden per-call via ChatCompletionParams.model. */
	model?: string
	/**
	 * Override the base URL.
	 *
	 * Defaults to the vendor's own endpoint. Set this for a gateway that
	 * fronts DeepSeek — but note that a gateway which strips unknown response
	 * fields will drop `reasoning_content`, and this driver's whole reason to
	 * exist is that field.
	 */
	baseURL?: string
	/** Request timeout in ms. */
	timeout?: number
	/** Custom headers appended to every request. */
	defaultHeaders?: Record<string, string>
	/**
	 * What to do when a caller sets a sampling parameter that thinking mode
	 * ignores — `temperature`, `topP`, `frequencyPenalty`, `presencePenalty`.
	 *
	 * The vendor accepts all four in thinking mode and applies none of them:
	 * no error, no warning, no effect. Measured against the live API on
	 * 2026-08-17, not read off the documentation, which says only that they
	 * are "not supported".
	 *
	 * `'refuse'` (the default) throws, because a caller who set `temperature:
	 * 0` and got sampling anyway believes they pinned something they did not
	 * — the exact shape of `refuse-do-not-degrade`. `'ignore'` sends them and
	 * lets the vendor discard them, for a host that would rather have one
	 * knob it can leave set across providers.
	 *
	 * Thinking is ON by default at the vendor, so this fires more often than
	 * you might expect. Disable thinking per call (`thinking: { type:
	 * 'disabled' }`) and the parameters are honoured normally.
	 */
	samplingInThinkingMode?: 'refuse' | 'ignore'
}

export interface DeepSeekProviderConfig extends DeepSeekConfig {
	type: 'deepseek'
}
