/**
 * Model context-window resolution for the compaction trigger.
 *
 * Compaction asks "how full is the window?". That question needs a WINDOW,
 * and the runtime previously answered it with `runConfig.tokenBudget` — the
 * run's cumulative spend cap. The two are different quantities, and using
 * the second as the divisor for the first is self-defeating: cumulative
 * spend always exceeds the live window, and the guard force-finalizes at
 * 0.9 x tokenBudget while compaction needs 0.7 x the same number, so the
 * mechanism raced its own budget. With the shipped CLI's
 * `tokenBudget: 1_000_000` the trigger sat at ~700k — far past any window
 * it targets.
 *
 * The table is a floor, not an oracle: a host that knows better passes
 * `contextWindowTokens` explicitly and this file is never consulted.
 */

/**
 * Conservative default for a model we do not recognise.
 *
 * Under-estimating is the safe direction: it compacts earlier than needed,
 * costing a summarization pass. Over-estimating means the run dies on a
 * provider `context_length_exceeded` with nothing recoverable.
 */
export const DEFAULT_ASSUMED_CONTEXT_WINDOW = 128_000

/**
 * Longest-prefix match table. Keys are matched against a lowercased model
 * id, so `claude-opus-5-20260514` resolves through `claude-opus-5`.
 * Ordered longest-first at lookup time, so a more specific key always wins
 * over a shorter one that also prefixes it.
 */
const WINDOWS: ReadonlyArray<readonly [prefix: string, tokens: number]> = [
	['claude-fable-5', 200_000],
	['claude-opus-5', 200_000],
	['claude-sonnet-5', 200_000],
	['claude-haiku-4-5', 200_000],
	['claude-opus-4', 200_000],
	['claude-sonnet-4', 200_000],
	['claude-3-7-sonnet', 200_000],
	['claude-3-5-sonnet', 200_000],
	['claude-3-5-haiku', 200_000],
	['claude-3-opus', 200_000],
	['claude-', 200_000],
	['gpt-5', 400_000],
	['gpt-4.1', 1_047_576],
	['gpt-4o', 128_000],
	['gpt-4-turbo', 128_000],
	['gpt-4', 8_192],
	['gpt-3.5-turbo', 16_385],
	['o3', 200_000],
	['o4-mini', 200_000],
	['gemini-2.5-pro', 1_048_576],
	['gemini-2.5-flash', 1_048_576],
	['gemini-1.5-pro', 2_097_152],
	['gemini-', 1_048_576],
	// Open weights, common local sizes
	['llama-3.3', 128_000],
	['llama-3.1', 128_000],
	['qwen', 32_768],
	['mistral-large', 128_000],
	['mixtral', 32_768],
	['deepseek', 64_000],
]

const SORTED = [...WINDOWS].sort((a, b) => b[0].length - a[0].length)

/**
 * Best-effort context window for a model id, or `undefined` when the id is
 * unrecognised. Gateway-qualified ids that prefix or namespace the
 * model name are handled by substring matching rather than a strict
 * prefix, since the same model ships under several namespaced ids.
 */
export function lookupContextWindow(model: string | undefined): number | undefined {
	if (!model) return undefined
	const id = model.toLowerCase()
	for (const [prefix, tokens] of SORTED) {
		if (id.includes(prefix)) return tokens
	}
	return undefined
}

export interface ResolvedContextWindow {
	readonly tokens: number
	readonly source: 'config' | 'model-table' | 'default'
}

/**
 * Resolve the window the compaction trigger measures against.
 *
 * Note what is NOT in the precedence list: `tokenBudget`. It is the wrong
 * quantity and having it as a fallback is what made the whole compaction
 * subsystem inert in every shipped consumer.
 */
export function resolveContextWindow(
	configured: number | undefined,
	model: string | undefined,
): ResolvedContextWindow {
	if (configured !== undefined && configured > 0) {
		return { tokens: configured, source: 'config' }
	}
	const known = lookupContextWindow(model)
	if (known !== undefined) {
		return { tokens: known, source: 'model-table' }
	}
	return { tokens: DEFAULT_ASSUMED_CONTEXT_WINDOW, source: 'default' }
}
