import { describe, expect, it } from 'vitest'
import { parseUnifiedLimits } from '../limits.js'

const NOW = 1_800_000_000_000
const headers = (values: Record<string, string>) => ({
	get: (name: string) => values[name.toLowerCase()] ?? null,
})

// Header names and units are the ones the vendor's own command line reads: a fraction for use,
// epoch seconds for the reset, and a status of allowed, allowed_warning or rejected.
const real = {
	'anthropic-ratelimit-unified-status': 'allowed',
	'anthropic-ratelimit-unified-5h-status': 'allowed',
	'anthropic-ratelimit-unified-5h-utilization': '0.27',
	'anthropic-ratelimit-unified-5h-reset': '1800003600',
	'anthropic-ratelimit-unified-5h-surpassed-threshold': '0',
	'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
	'anthropic-ratelimit-unified-7d-utilization': '0.05',
	'anthropic-ratelimit-unified-7d-reset': '1800200000',
	'anthropic-ratelimit-unified-representative-claim': 'five_hour',
}

describe('parseUnifiedLimits', () => {
	it('reads both windows: a fraction for use and epoch seconds as milliseconds', () => {
		expect(parseUnifiedLimits(headers(real), NOW)).toEqual({
			windows: [
				{ label: '5-hour limit', usedFraction: 0.27, resetsAt: 1_800_003_600_000 },
				{ label: 'Weekly · all models', usedFraction: 0.05, resetsAt: 1_800_200_000_000 },
			],
			asOf: NOW,
		})
	})

	it('reports nothing, never zero, when the headers are absent (an API key)', () => {
		expect(parseUnifiedLimits(headers({}), NOW)).toBeUndefined()
		expect(parseUnifiedLimits(headers({ 'retry-after': '30' }), NOW)).toBeUndefined()
	})

	it('keeps a window that is partly there and leaves out one with nothing usable', () => {
		const partial = parseUnifiedLimits(
			headers({
				'anthropic-ratelimit-unified-5h-utilization': '0.4',
				'anthropic-ratelimit-unified-7d-reset': '1800200000',
			}),
			NOW,
		)
		expect(partial?.windows).toEqual([{ label: '5-hour limit', usedFraction: 0.4 }])
	})

	it('drops bad values instead of guessing', () => {
		const bad = parseUnifiedLimits(
			headers({
				'anthropic-ratelimit-unified-5h-utilization': 'lots',
				'anthropic-ratelimit-unified-5h-reset': 'soon',
				'anthropic-ratelimit-unified-7d-utilization': '-0.2',
			}),
			NOW,
		)
		expect(bad).toBeUndefined()
		const resetOnly = parseUnifiedLimits(
			headers({
				'anthropic-ratelimit-unified-5h-utilization': '0.5',
				'anthropic-ratelimit-unified-5h-reset': 'NaN',
			}),
			NOW,
		)
		expect(resetOnly?.windows).toEqual([{ label: '5-hour limit', usedFraction: 0.5 }])
	})

	it('clamps use above one, and a rejected window is full whatever number came with it', () => {
		const out = parseUnifiedLimits(
			headers({
				'anthropic-ratelimit-unified-5h-utilization': '1.3',
				'anthropic-ratelimit-unified-7d-status': 'rejected',
				'anthropic-ratelimit-unified-7d-utilization': '0.9',
			}),
			NOW,
		)
		expect(out?.windows?.[0]?.usedFraction).toBe(1)
		expect(out?.windows?.[1]).toEqual({
			label: 'Weekly · all models',
			usedFraction: 1,
			rejected: true,
		})
	})

	it('carries no plan name: the headers do not give one', () => {
		expect(parseUnifiedLimits(headers(real), NOW)).not.toHaveProperty('plan')
	})
})
