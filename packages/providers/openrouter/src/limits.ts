import type { ProviderLimits } from '@namzu/sdk'

const number = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/**
 * The key's limit and use from `GET /key`. The body is `{ data: { limit, limit_remaining, usage, ... } }`
 * with `limit` and `limit_remaining` null for a key without a cap. When the vendor names a budget
 * in dollars (`effective_budget`) that is what is shown; otherwise the key's own numbers, which the
 * vendor counts in credits. A body that does not match is "not reported" (`undefined`), never a zero.
 */
export function parseKeyLimits(body: unknown, now: number): ProviderLimits | undefined {
	if (typeof body !== 'object' || body === null) return undefined
	const data = (body as { data?: unknown }).data
	if (typeof data !== 'object' || data === null) return undefined
	const key = data as Record<string, unknown>
	const budget = key.effective_budget
	if (typeof budget === 'object' && budget !== null) {
		const {
			limit_usd: limit,
			spend_usd: used,
			remaining_usd: remaining,
		} = budget as Record<string, unknown>
		if (number(limit) !== undefined && number(used) !== undefined)
			return {
				credit: {
					currency: 'USD',
					limit: number(limit) as number,
					used: number(used) as number,
					...(number(remaining) !== undefined ? { remaining: number(remaining) as number } : {}),
				},
				asOf: now,
			}
	}
	const used = number(key.usage)
	if (used === undefined) return undefined
	const limit = number(key.limit)
	const remaining = number(key.limit_remaining)
	return {
		credit: {
			currency: 'credits',
			used,
			...(limit !== undefined ? { limit } : {}),
			...(remaining !== undefined ? { remaining } : {}),
		},
		asOf: now,
	}
}
