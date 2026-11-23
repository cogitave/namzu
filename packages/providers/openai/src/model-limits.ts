/**
 * Reading limits out of a model catalogue row, shared by the API-key client and the subscription
 * route so the two spell the same fields the same way.
 */

/** The first of these fields of `row` that holds a positive safe integer. */
export function firstCount(
	row: Record<string, unknown> | undefined,
	wires: readonly string[],
): number | undefined {
	for (const wire of wires) {
		const value = row?.[wire]
		if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
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

/**
 * The share of the window the backend says a prompt may use, as a fraction in (0, 1], when the
 * row sends one (`effective_context_window_percent`, 1 to 100). Anything else is not a statement.
 */
export function effectiveWindowFraction(row: Record<string, unknown> | undefined) {
	const percent = row?.effective_context_window_percent
	if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined
	if (percent <= 0 || percent > 100) return undefined
	return percent / 100
}
