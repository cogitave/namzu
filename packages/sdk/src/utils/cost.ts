import { ZERO_COST } from '../constants/limits.js'
import type { CostInfo, TokenUsage } from '../types/common/index.js'

/**
 * What a driver's cache tokens cost, and what they mean.
 *
 * `promptIncludesCacheReads` is a property of the DRIVER, not of the model, and
 * it is why this is a nested object rather than two more rate fields. The
 * drivers in this repository disagree about it: two report `promptTokens`
 * excluding cache reads and charge them on top, one reports `promptTokens`
 * already containing them. Applying a read rate without knowing which one you
 * have is wrong by the entire cache volume, in a direction that changes with
 * whoever served the turn — so the fact travels with the rates and is never
 * inferred.
 */
export interface CacheRates {
	/**
	 * `true`: `usage.cachedTokens` is a SUBSET of `usage.promptTokens`, so the
	 * billable input is the difference.
	 * `false`: they are additional to it.
	 */
	readonly promptIncludesCacheReads: boolean
	readonly readCostPer1M: number
	/**
	 * Absent when the driver never reports a cache write. Tokens that arrive
	 * anyway are counted as unpriced rather than charged at some neighbouring
	 * rate, so a driver that starts reporting them surfaces as a gap instead of
	 * a quietly wrong total.
	 */
	readonly writeCostPer1M?: number
}

export interface ModelPricing {
	inputCostPer1M: number
	outputCostPer1M: number
	/**
	 * Absent means the caller declared a two-rate card and gets a two-rate
	 * answer: prompt and completion tokens are priced, and cache tokens are
	 * left inside whichever of those the driver already counted them in. That
	 * is the host-supplied case and it is a declaration, not a guess on our
	 * part. The catalogue always supplies this.
	 */
	cache?: CacheRates
}

export { ZERO_COST }

interface Priced {
	readonly cost: number
	/** What the cache reads saved against paying the full input rate. */
	readonly cacheDiscount: number
	/** Tokens this rate card had no rate for. */
	readonly unpriced: number
}

function priceUsage(usage: TokenUsage, pricing: ModelPricing): Priced {
	const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate

	const cache = pricing.cache
	if (cache === undefined) {
		return {
			cost:
				perMillion(usage.promptTokens, pricing.inputCostPer1M) +
				perMillion(usage.completionTokens, pricing.outputCostPer1M),
			cacheDiscount: 0,
			unpriced: 0,
		}
	}

	// Never negative: a driver that reports more cached tokens than prompt
	// tokens is contradicting itself, and clamping keeps that from turning into
	// a credit on the bill.
	const billableInput = cache.promptIncludesCacheReads
		? Math.max(0, usage.promptTokens - usage.cachedTokens)
		: usage.promptTokens

	const writesRated = cache.writeCostPer1M !== undefined

	return {
		cost:
			perMillion(billableInput, pricing.inputCostPer1M) +
			perMillion(usage.completionTokens, pricing.outputCostPer1M) +
			perMillion(usage.cachedTokens, cache.readCostPer1M) +
			(writesRated ? perMillion(usage.cacheWriteTokens, cache.writeCostPer1M as number) : 0),
		// Reported, not subtracted. The saving is already inside `cost` — the
		// reads were charged at the read rate rather than the input rate — so
		// taking it off again would double-count it. This field was previously
		// declared, defaulted to zero at both call sites, and passed by nobody;
		// it now carries the one quantity it was always named for.
		cacheDiscount: perMillion(usage.cachedTokens, pricing.inputCostPer1M - cache.readCostPer1M),
		unpriced: writesRated ? 0 : usage.cacheWriteTokens,
	}
}

export function calculateCost(usage: TokenUsage, pricing: ModelPricing): CostInfo {
	const priced = priceUsage(usage, pricing)
	return {
		inputCostPer1M: pricing.inputCostPer1M,
		outputCostPer1M: pricing.outputCostPer1M,
		totalCost: priced.cost,
		cacheDiscount: priced.cacheDiscount,
		unpricedTokens: priced.unpriced,
	}
}

/**
 * Whether `current` is a total nothing has been added to yet.
 *
 * All three conditions, not one. A run whose only turn so far was unpriced has
 * a zero total and no rate fields too, and adopting the next turn's rate card
 * as though it described the whole total would be exactly the wrong claim.
 *
 * This predicate is only sound while every writer of a `CostInfo` goes through
 * this module or states the truth in its vocabulary. One did not:
 * `projectEmergencyToCheckpoint` wrote `ZERO_COST` beside a real, non-zero
 * `tokenUsage`, which is byte-identical to a fresh total — so a run resumed
 * from an emergency dump would have adopted its next turn's rate card as
 * covering spend that happened before the crash. That projection now records
 * the pre-crash tokens as unpriced, which is both true and, usefully, not
 * fresh-shaped.
 */
function isFresh(current: CostInfo): boolean {
	return (
		current.totalCost === 0 &&
		current.unpricedTokens === 0 &&
		current.inputCostPer1M === undefined &&
		current.outputCostPer1M === undefined
	)
}

/**
 * The rate fields that honestly describe `current + pricing`.
 *
 * Kept when one card still covers the whole total; dropped when it does not.
 * Dropping rather than overwriting is the change: the previous version wrote
 * the incoming card over whatever was there, so a run that swapped models
 * reported the last card applied as though it had priced every token.
 *
 * Equal-but-distinct cards are treated as one, deliberately. Two models at the
 * same published rate produce a total that a single rate card DOES describe,
 * which is the only claim these two fields make — they name a rate, not a
 * model, and `Run.steps[].servedBy` carries which model served each turn.
 */
function ratesFor(
	current: CostInfo,
	pricing: ModelPricing,
): Pick<CostInfo, 'inputCostPer1M' | 'outputCostPer1M'> {
	const incoming = {
		inputCostPer1M: pricing.inputCostPer1M,
		outputCostPer1M: pricing.outputCostPer1M,
	}
	if (isFresh(current)) return incoming
	if (
		current.inputCostPer1M === pricing.inputCostPer1M &&
		current.outputCostPer1M === pricing.outputCostPer1M
	) {
		return incoming
	}
	return {}
}

export function accumulateCost(
	current: CostInfo,
	additionalUsage: TokenUsage,
	pricing: ModelPricing,
): CostInfo {
	const priced = priceUsage(additionalUsage, pricing)
	const rates = priced.unpriced > 0 ? {} : ratesFor(current, pricing)
	return {
		...rates,
		totalCost: current.totalCost + priced.cost,
		cacheDiscount: current.cacheDiscount + priced.cacheDiscount,
		unpricedTokens: current.unpricedTokens + priced.unpriced,
	}
}

/**
 * Record tokens that were consumed at a rate nobody has.
 *
 * The alternative was to add nothing and leave the total alone, which is how
 * every run came to report `$0.00` for work that cost real money. Counting the
 * tokens instead makes the gap a fact the caller can read and the budget guard
 * can refuse on, rather than an absence that looks like an answer.
 *
 * The rate fields go, if they were there: a total that omits part of a run is
 * not described by any single card.
 */
export function accumulateUnpricedCost(current: CostInfo, additionalUsage: TokenUsage): CostInfo {
	return {
		totalCost: current.totalCost,
		cacheDiscount: current.cacheDiscount,
		unpricedTokens: current.unpricedTokens + additionalUsage.totalTokens,
	}
}

export function formatCost(usd: number): string {
	if (usd === 0) return '$0.00'
	if (usd < 0.01) return `$${usd.toFixed(4)}`
	return `$${usd.toFixed(2)}`
}

/**
 * How a total should be shown, given what is and is not known about it.
 *
 * Exists so that no surface has to re-derive the free/unknown distinction from
 * two fields and get it subtly wrong. `@namzu/cli` printed
 * `'$0.0000 (this provider reported no price)'` for every run, because every
 * run was unpriced; now the two cases really are different and the string has
 * to follow.
 */
export function describeCost(cost: CostInfo): string {
	if (cost.unpricedTokens === 0) return formatCost(cost.totalCost)
	if (cost.totalCost === 0) {
		return `unknown (${cost.unpricedTokens} tokens at no known rate)`
	}
	return `at least ${formatCost(cost.totalCost)} (${cost.unpricedTokens} tokens at no known rate)`
}
