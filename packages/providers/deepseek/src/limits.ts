import type { ProviderLimits } from '@namzu/sdk'

/**
 * The account balance from the vendor's balance endpoint. The body carries `balance_infos`, one
 * entry per currency, each with its amounts as decimal strings. The first entry that reads is
 * used; anything that does not match the documented shape is "not reported" (`undefined`),
 * never a zero.
 */
export function parseBalance(body: unknown, now: number): ProviderLimits | undefined {
	if (typeof body !== 'object' || body === null) return undefined
	const infos = (body as { balance_infos?: unknown }).balance_infos
	if (!Array.isArray(infos)) return undefined
	for (const info of infos) {
		if (typeof info !== 'object' || info === null) continue
		const { currency, total_balance: total } = info as {
			currency?: unknown
			total_balance?: unknown
		}
		if (typeof currency !== 'string' || currency === '' || typeof total !== 'string') continue
		const remaining = total.trim() === '' ? Number.NaN : Number(total)
		if (!Number.isFinite(remaining) || remaining < 0) continue
		return { credit: { currency, remaining }, asOf: now }
	}
	return undefined
}
