import type { ProviderLimitWindow, ProviderLimits } from '@namzu/sdk'

/** What the parser needs of a response's headers; a fetch `Headers` has it. */
export interface HeaderReader {
	get(name: string): string | null
}

const WINDOWS: readonly { key: string; label: string }[] = [
	{ key: '5h', label: '5-hour limit' },
	{ key: '7d', label: 'Weekly · all models' },
]

const finite = (value: string | null): number | undefined => {
	if (value === null || value.trim() === '') return undefined
	const number = Number(value)
	return Number.isFinite(number) ? number : undefined
}

/**
 * The subscription windows a response's headers carry: for each of the five-hour and seven-day
 * windows, how much is used (a fraction from 0 to 1), when it resets (epoch seconds), and whether
 * the vendor refused for it. A window with nothing usable is left out, a bad value is dropped
 * rather than guessed, and with no window at all the answer is `undefined`: not reported, never
 * zero. Reads headers only; nothing is sent.
 */
export function parseUnifiedLimits(headers: HeaderReader, now: number): ProviderLimits | undefined {
	const windows: ProviderLimitWindow[] = []
	for (const { key, label } of WINDOWS) {
		const prefix = `anthropic-ratelimit-unified-${key}`
		const used = finite(headers.get(`${prefix}-utilization`))
		const reset = finite(headers.get(`${prefix}-reset`))
		const rejected = headers.get(`${prefix}-status`)?.trim() === 'rejected'
		// A window the vendor refused for is full whatever number came with it.
		const usedFraction = rejected
			? 1
			: used === undefined || used < 0
				? undefined
				: Math.min(1, used)
		if (usedFraction === undefined) continue
		windows.push({
			label,
			usedFraction,
			...(reset !== undefined && reset > 0 ? { resetsAt: Math.round(reset) * 1000 } : {}),
			...(rejected ? { rejected: true } : {}),
		})
	}
	return windows.length > 0 ? { windows, asOf: now } : undefined
}
