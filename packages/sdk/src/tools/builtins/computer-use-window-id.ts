/**
 * A window has one number and several spellings: a list prints it as `0x2b040a`, a driver message as
 * `2819082`, and a model may send either, a bare number, or the handle object it saw in some output.
 * Everything the tool remembers about a window is keyed by the number, so a click, a screenshot and a
 * snapshot of "the same window" agree whatever spelling each one used.
 */

const HANDLE_KEYS = ['window_id', 'windowId', 'hwnd', 'handle', 'id', 'value'] as const

/** The window number a spelling stands for, or undefined when it is not a number at all. */
export function windowNumber(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : undefined
	if (typeof value === 'bigint')
		return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
	if (typeof value === 'string') {
		const text = value.trim().toLowerCase()
		const parsed = /^0x[0-9a-f]+$/.test(text)
			? Number.parseInt(text.slice(2), 16)
			: /^\d+$/.test(text)
				? Number.parseInt(text, 10)
				: Number.NaN
		return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
	}
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const record = value as Record<string, unknown>
		for (const key of HANDLE_KEYS) {
			if (record[key] === undefined || typeof record[key] === 'object') continue
			const found = windowNumber(record[key])
			if (found !== undefined) return found
		}
	}
	return undefined
}

/**
 * What the model sent as a window id, as the string the rest of the tool reads: a number or a handle
 * object becomes the `0x…` form a window list prints. Text that is not a number is left alone.
 */
export function coerceWindowId(value: unknown): unknown {
	if (typeof value === 'string') return value
	const found = windowNumber(value)
	return found === undefined ? value : `0x${found.toString(16)}`
}

/** The key a window is remembered by: its number when it has one, else the text as given. */
export function windowKey(id: string | undefined): string {
	if (id === undefined) return ''
	const found = windowNumber(id)
	return found === undefined ? id : String(found)
}
