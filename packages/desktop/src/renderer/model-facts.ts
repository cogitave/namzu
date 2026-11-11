import type { ModelCatalogueView } from '../shared/protocol.js'
import { formatTokens } from './context-ring.js'

type Row = ModelCatalogueView['models'][number]

/** A rate in dollars for a million tokens: 3, 0.25, 12.5. Never more than two decimals. */
function dollars(rate: number): string {
	const text = rate >= 10 ? rate.toFixed(0) : rate.toFixed(2).replace(/\.?0+$/, '')
	return `$${text}`
}

/**
 * The second line of a model row: its context window and what a million tokens cost, as the
 * model's own source published them. A value the source did not publish is left out, never
 * guessed, and a model with nothing known has no second line at all.
 */
export function modelFacts(
	row: Pick<Row, 'contextWindow' | 'inputPrice' | 'outputPrice'>,
): string | undefined {
	const parts: string[] = []
	if (row.contextWindow !== undefined && row.contextWindow > 0)
		parts.push(`${formatTokens(row.contextWindow)} window`)
	const { inputPrice, outputPrice } = row
	if (inputPrice === 0 && outputPrice === 0) parts.push('Free')
	else if (inputPrice !== undefined && outputPrice !== undefined)
		parts.push(`${dollars(inputPrice)} in · ${dollars(outputPrice)} out per 1M`)
	return parts.length ? parts.join(' · ') : undefined
}
