/**
 * Reading limits out of a model catalogue row, shared by the API-key client and the subscription
 * route so the two spell the same fields the same way.
 */

/** A number, or a string that holds one (some backends send counts as strings). */
function asNumber(value: unknown): number | undefined {
	if (typeof value === 'number') return value
	if (typeof value === 'string' && value.trim() !== '') return Number(value)
	return undefined
}

/** The first of these fields of `row` that holds a positive safe integer. */
export function firstCount(
	row: Record<string, unknown> | undefined,
	wires: readonly string[],
): number | undefined {
	for (const wire of wires) {
		const value = asNumber(row?.[wire])
		if (value !== undefined && Number.isSafeInteger(value) && value > 0) return value
	}
	return undefined
}

/** The spellings catalogues use for the context window, in the order they are tried. */
export const CONTEXT_WINDOW_WIRES: readonly string[] = [
	'context_window_tokens',
	'context_window',
	'context_length',
	'max_model_len',
	'max_context_window',
]

/** The window a catalogue row states, or `undefined` when it states none. */
export function declaredContextWindow(row: Record<string, unknown> | undefined) {
	return firstCount(row, CONTEXT_WINDOW_WIRES)
}

/** The share of a window the subscription backend counts as usable when its row states none. */
export const SUBSCRIPTION_DEFAULT_USABLE_PERCENT = 95

/** The share of the resolved window the backend caps its auto-compact limit at. */
const SUBSCRIPTION_COMPACT_CAP_PERCENT = 90

/** What the subscription backend's model row says about the window and compaction. */
export interface SubscriptionLimits {
	/** `context_window`, else `max_context_window`, scaled by the usable percent. */
	readonly contextWindow?: number
	/** The backend's compaction threshold: its limit held to 90% of the window, or 90% alone. */
	readonly autoCompactTokenLimit?: number
}

/**
 * Read one row of the subscription backend's `/models` answer the way the backend defines it:
 *
 * - resolved window = `context_window`, else `max_context_window`
 * - usable window = resolved x `effective_context_window_percent` / 100, the percent being 95
 *   when the row omits it
 * - auto-compact limit = `auto_compact_token_limit` held to 90% of the resolved window, or 90%
 *   of it alone when the row sends none, or the row's limit alone when there is no window
 *
 * Counts may arrive as numbers or numeric strings. Only this route applies the percent; the
 * other compatible hosts go through `declaredContextWindow`.
 */
export function subscriptionLimits(row: Record<string, unknown> | undefined): SubscriptionLimits {
	const resolved = firstCount(row, ['context_window', 'max_context_window'])
	const statedLimit = firstCount(row, ['auto_compact_token_limit'])
	const percentValue = asNumber(row?.effective_context_window_percent)
	const percent =
		percentValue !== undefined && Number.isFinite(percentValue) && percentValue > 0
			? Math.min(percentValue, 100)
			: SUBSCRIPTION_DEFAULT_USABLE_PERCENT
	const contextWindow =
		resolved === undefined ? undefined : Math.max(1, Math.floor((resolved * percent) / 100))
	let autoCompactTokenLimit: number | undefined
	if (resolved !== undefined) {
		const cap = Math.max(1, Math.floor((resolved * SUBSCRIPTION_COMPACT_CAP_PERCENT) / 100))
		autoCompactTokenLimit = statedLimit === undefined ? cap : Math.min(statedLimit, cap)
	} else {
		autoCompactTokenLimit = statedLimit
	}
	return {
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(autoCompactTokenLimit !== undefined ? { autoCompactTokenLimit } : {}),
	}
}
