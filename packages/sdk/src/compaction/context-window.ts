/**
 * Model context-window resolution for the compaction trigger.
 *
 * Compaction asks "how full is the window?". That question needs a WINDOW,
 * and the runtime previously answered it with `turnConfig.tokenBudget` — the
 * turn's cumulative spend cap. The two are different quantities, and using
 * the second as the divisor for the first is self-defeating: cumulative
 * spend always exceeds the live window, and the guard force-finalizes at
 * 0.9 x tokenBudget while compaction needs 0.7 x the same number, so the
 * mechanism raced its own budget. With the shipped CLI's
 * `tokenBudget: 1_000_000` the trigger sat at ~700k — far past any window
 * it targets.
 *
 * The table is a floor, not an oracle: a host that knows better passes
 * `contextWindowTokens` explicitly and this file is never consulted.
 *
 * "Floor" governs the model we do NOT recognise — that is what
 * `DEFAULT_ASSUMED_CONTEXT_WINDOW` is for. It does not license a wrong
 * number for a model the table names. Every entry below carried 200k for
 * the whole Claude family, including the models whose window is 1M, and
 * understating a window by 5x is not caution: the trigger fires at 0.7 x
 * the divisor, so a 1M-window run compacted at ~14% full. Each of those
 * runs paid a summarization pass it did not need and threw away the prompt
 * cache prefix to do it.
 *
 * The values are read off the published model comparison rather than
 * recalled. The durable fix is to ask the provider — the Models API
 * reports a window per model id — which would end the drift this table
 * accumulates every release. Until a driver does that, an entry here is
 * only ever as fresh as the day someone checked it.
 */

/** The window an id declares with the `[1m]` suffix, and the ceiling `NAMZU_AUTO_COMPACT_WINDOW` accepts. */
export const ONE_MILLION_WINDOW_TOKENS = 1_000_000
/** The window a model is held to when `NAMZU_DISABLE_1M_CONTEXT` is on. */
export const DISABLED_ONE_MILLION_WINDOW_CAP_TOKENS = 200_000

const WINDOW_SUFFIX = /\[1m\]$/i

/**
 * A model id may end in `[1m]` (any case) to declare a one-million-token
 * window, whether or not the id is recognised. The suffix is a marker for
 * Namzu, never part of the vendor's name: strip it with this before an id
 * reaches a driver or a wire.
 */
export function splitModelWindowSuffix(model: string): {
	readonly model: string
	readonly declaresOneMillion: boolean
} {
	const match = WINDOW_SUFFIX.exec(model)
	if (!match) return { model, declaresOneMillion: false }
	return { model: model.slice(0, match.index), declaresOneMillion: true }
}

/** The id with any `[1m]` suffix removed. */
export function stripModelWindowSuffix(model: string): string {
	return splitModelWindowSuffix(model).model
}

/**
 * `NAMZU_DISABLE_1M_CONTEXT` (1, true, yes or on): the suffix is still
 * stripped but declares nothing, and no window above 200,000 tokens is
 * assumed for a model whose window comes from a driver or the table.
 */
export function oneMillionWindowDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.NAMZU_DISABLE_1M_CONTEXT?.trim().toLowerCase()
	return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

/** Smallest and largest window `NAMZU_AUTO_COMPACT_WINDOW` can name. */
export const AUTO_COMPACT_WINDOW_MIN_TOKENS = 100_000
export const AUTO_COMPACT_WINDOW_MAX_TOKENS = ONE_MILLION_WINDOW_TOKENS

export type AutoCompactWindowParse =
	| { readonly kind: 'in_range'; readonly tokens: number }
	| { readonly kind: 'below_minimum'; readonly tokens: number }
	| { readonly kind: 'above_maximum' }
	| { readonly kind: 'unusable' }

/**
 * Read an automatic-summary window the way people write one: a plain number
 * (`200000`) or one with a `k` or `m` suffix (`786k`, `1m`, `1.5m`). Anything
 * under 100,000 is `below_minimum`, over 1,000,000 `above_maximum`, and
 * something that is not a size at all `unusable`.
 */
export function parseAutoCompactWindow(raw: string): AutoCompactWindowParse {
	const text = raw.trim()
	const last = text.slice(-1).toLowerCase()
	const scale = last === 'm' ? 1_000_000 : last === 'k' ? 1_000 : undefined
	const digits = scale === undefined ? text : text.slice(0, -1)
	const valid = scale === undefined ? /^\+?\d+$/ : /^\+?\d+(\.\d+)?$/
	const value = valid.test(digits) ? Number(digits) * (scale ?? 1) : Number.NaN
	if (Number.isNaN(value) || value < 1) return { kind: 'unusable' }
	if (value < AUTO_COMPACT_WINDOW_MIN_TOKENS)
		return {
			kind: 'below_minimum',
			tokens: Math.min(AUTO_COMPACT_WINDOW_MIN_TOKENS - 1, Math.round(value)),
		}
	if (value > AUTO_COMPACT_WINDOW_MAX_TOKENS) return { kind: 'above_maximum' }
	return { kind: 'in_range', tokens: Math.round(value) }
}

/**
 * The window to use for a written size, and a one-line warning when what was
 * written had to be changed: below 100,000 reads as 100,000, above 1,000,000
 * as 1,000,000, and a non-size is ignored (`tokens` undefined). `source`
 * names where it was written, e.g. `NAMZU_AUTO_COMPACT_WINDOW`.
 */
export function resolveAutoCompactWindowSetting(
	raw: string | number,
	source: string,
): { readonly tokens: number | undefined; readonly warning?: string } {
	const text = String(raw)
	const parsed = parseAutoCompactWindow(text)
	const shown = `${source}="${text.slice(0, 32).replace(/[^\w.,+ $%{}=;-]+/g, '?')}${text.length > 32 ? '\u2026' : ''}"`
	const advice = 'Set it to a size from 100k to 1M, such as 200k or 200000, or unset it.'
	switch (parsed.kind) {
		case 'in_range':
			return { tokens: parsed.tokens }
		case 'below_minimum':
			return {
				tokens: AUTO_COMPACT_WINDOW_MIN_TOKENS,
				warning: `${shown} reads as ${parsed.tokens.toLocaleString('en-US')} tokens, so Namzu treats it as the 100k minimum. ${advice}`,
			}
		case 'above_maximum':
			return {
				tokens: AUTO_COMPACT_WINDOW_MAX_TOKENS,
				warning: `${shown} is too large, so Namzu treats it as the 1M maximum. ${advice}`,
			}
		case 'unusable':
			return {
				tokens: undefined,
				warning: `${shown} isn't a usable size, so Namzu ignores it. ${advice}`,
			}
	}
}

/**
 * Conservative default for a model we do not recognise.
 *
 * Under-estimating is the safe direction: it compacts earlier than needed,
 * costing a summarization pass. Over-estimating means the turn dies on a
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
	['claude-fable-5', 1_000_000],
	['claude-mythos', 1_000_000],
	['claude-opus-5', 1_000_000],
	['claude-sonnet-5', 1_000_000],
	['claude-opus-4-8', 1_000_000],
	['claude-opus-4-7', 1_000_000],
	['claude-opus-4-6', 1_000_000],
	['claude-sonnet-4-6', 1_000_000],
	// The 4.5 generation is 200k, so the two 4.5 keys have to out-rank the
	// bare `claude-opus-4` / `claude-sonnet-4` entries below AND stay
	// distinct from their 1M siblings above. Longest-key-wins does that.
	['claude-haiku-4-5', 200_000],
	['claude-sonnet-4-5', 200_000],
	['claude-opus-4-5', 200_000],
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
	// The current DeepSeek models document a 1M window
	// (https://api-docs.deepseek.com/quick_start/pricing), listed per id: a
	// gateway can serve a derivative under a name that merely starts like one
	// (a fine-tune, a distill), and nothing says it keeps the parent's window.
	// Over-estimating ends a turn on a provider rejection; under-estimating
	// costs a summary. So an id not named here falls to the bare `deepseek`
	// row below, the 64k the older ids (chat, reasoner, R1 distills) had.
	['deepseek-v4-flash', 1_000_000],
	['deepseek-v4-pro', 1_000_000],
	['deepseek-flash', 1_000_000],
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
	const { declaresOneMillion } = splitModelWindowSuffix(model)
	const known = lookupBareContextWindow(model)
	if (declaresOneMillion && !oneMillionWindowDisabled()) {
		return Math.max(known ?? 0, ONE_MILLION_WINDOW_TOKENS)
	}
	return known
}

/** The table's answer for an id with any `[1m]` suffix ignored. */
function lookupBareContextWindow(model: string | undefined): number | undefined {
	if (!model) return undefined
	const id = stripModelWindowSuffix(model).toLowerCase()
	for (const [prefix, tokens] of SORTED) {
		if (id.includes(prefix)) return tokens
	}
	return undefined
}

/** Output room the trigger keeps free: the model's output cap, at most this many tokens. */
export const TRIGGER_OUTPUT_RESERVE_CAP_TOKENS = 20_000
/** Extra headroom below the reserved window before a summary is due. */
export const TRIGGER_BUFFER_TOKENS = 13_000
/**
 * The derived trigger never drops below this fraction of the window. The
 * reference subtracts 33,000 tokens outright; on a window under about 66,000
 * that is most of it (or more than all of it), and a summary on every
 * iteration is not a trigger.
 */
export const MIN_DERIVED_TRIGGER_FRACTION = 0.5

/**
 * The fraction of the window at which older history is summarised.
 *
 * A host that set `triggerThreshold` gets exactly that. Otherwise the
 * trigger is the window, less room kept for the
 * reply (the model's output cap, at most 20,000 tokens), less a 13,000-token
 * buffer. On a 200,000-token window that is 167,000 tokens (83.5%); on a
 * 1,000,000-token window, 967,000 (96.7%).
 *
 * `maxOutputTokens` is what the driver declares for the model; absent, the
 * full 20,000 is reserved.
 */
export function resolveTriggerThreshold(
	configured: number | undefined,
	windowTokens: number,
	maxOutputTokens?: number,
	autoCompactWindowTokens?: number,
): number {
	if (
		autoCompactWindowTokens !== undefined &&
		(!Number.isSafeInteger(autoCompactWindowTokens) || autoCompactWindowTokens <= 0)
	)
		throw new RangeError('autoCompactWindowTokens must be a positive safe integer.')
	if (autoCompactWindowTokens !== undefined && windowTokens > 0) {
		const window = Math.min(windowTokens, autoCompactWindowTokens)
		return (resolveTriggerThreshold(configured, window, maxOutputTokens) * window) / windowTokens
	}
	if (configured !== undefined) return configured
	if (!(windowTokens > 0)) return MIN_DERIVED_TRIGGER_FRACTION
	const reserve = Math.min(
		maxOutputTokens !== undefined && maxOutputTokens > 0
			? maxOutputTokens
			: TRIGGER_OUTPUT_RESERVE_CAP_TOKENS,
		TRIGGER_OUTPUT_RESERVE_CAP_TOKENS,
	)
	const fraction = (windowTokens - reserve - TRIGGER_BUFFER_TOKENS) / windowTokens
	return Math.min(1, Math.max(MIN_DERIVED_TRIGGER_FRACTION, fraction))
}

export interface ResolvedContextWindow {
	readonly tokens: number
	/**
	 * Where the number came from, ranked in that order.
	 *
	 * `'provider'` sits between the two for a reason: a host that set a
	 * number said what they want and outranks any discovery, while the
	 * table is a guess maintained by hand and the vendor's own answer is
	 * not.
	 */
	readonly source: 'config' | 'provider' | 'model-table' | 'default'
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
	/**
	 * What the driver said, already resolved.
	 *
	 * A plain number rather than a promise, because both call sites are
	 * synchronous and sit in the hot loop. Resolving happens once at the
	 * start of a turn; this parameter is that answer being carried in.
	 */
	providerReported?: number,
): ResolvedContextWindow {
	if (configured !== undefined && configured > 0) {
		return { tokens: configured, source: 'config' }
	}
	const { declaresOneMillion } = splitModelWindowSuffix(model ?? '')
	const disabled = oneMillionWindowDisabled()
	const base = resolveUndeclaredWindow(model, providerReported)
	// `[1m]` raises the window to at least a million (reported as 'model-table':
	// the id itself is the fact), never lowers one a
	// driver or the table already puts higher.
	if (declaresOneMillion && !disabled && base.tokens < ONE_MILLION_WINDOW_TOKENS) {
		return { tokens: ONE_MILLION_WINDOW_TOKENS, source: 'model-table' }
	}
	// With the million-token window switched off, nothing assumed or reported
	// for a model counts for more than 200,000.
	if (disabled && base.tokens > DISABLED_ONE_MILLION_WINDOW_CAP_TOKENS) {
		return { tokens: DISABLED_ONE_MILLION_WINDOW_CAP_TOKENS, source: base.source }
	}
	return base
}

function resolveUndeclaredWindow(
	model: string | undefined,
	providerReported: number | undefined,
): ResolvedContextWindow {
	if (providerReported !== undefined && providerReported > 0) {
		return { tokens: providerReported, source: 'provider' }
	}
	// A driver that resolved `undefined` falls through to HERE, not to the
	// default. "I asked and it does not know" leaves the table exactly as
	// authoritative as it was before anyone asked.
	const known = lookupBareContextWindow(model)
	if (known !== undefined) {
		return { tokens: known, source: 'model-table' }
	}
	return { tokens: DEFAULT_ASSUMED_CONTEXT_WINDOW, source: 'default' }
}
