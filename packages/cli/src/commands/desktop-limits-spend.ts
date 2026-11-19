import { systemClock } from '../integrations/spend/day.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { buildCostReport } from './cost.js'

const DAYS = 30
/** The ledger is read again at most this often. */
const REUSE_MS = 60_000

let cached: { at: number; report: Awaited<ReturnType<typeof buildCostReport>> } | undefined

/**
 * What a provider's key has cost over the last 30 days at list prices, from the local record of the
 * conversations on this machine. An estimate, never a bill: tokens with no known price are not
 * turned into money, and the answer says it is partial. Reads files only; nothing is requested.
 */
export async function localSpendEstimate(
	provider: string,
	now: () => number = Date.now,
): Promise<{ usd: number; days: number; partial: boolean } | undefined> {
	if (!cached || now() - cached.at >= REUSE_MS) {
		cached = {
			at: now(),
			report: await buildCostReport(DAYS, { home: resolveNamzuHome(), clock: systemClock() }),
		}
	}
	const rows = cached.report.models.filter((row) => row.provider === provider)
	if (rows.length === 0) return undefined
	return {
		usd: rows.reduce((sum, row) => sum + row.estimatedCostUsd, 0),
		days: DAYS,
		partial: rows.some((row) => row.unpricedTokens > 0 || !row.priceKnown),
	}
}
