/**
 * Rate lookup for a run's tokens.
 *
 * The kernel had a cost calculation and no data to feed it: `costInfo` moved
 * only when a host passed `pricing` to `query()`, no shipped surface passed
 * one, and so every run reported a total of zero. `runConfig.costLimitUsd` is
 * enforced against that same total, which made a declared budget a budget that
 * could never trigger.
 *
 * This is the data. It is IN-TREE and versioned at build time rather than
 * fetched, so a cost number is reproducible from a commit and an offline run
 * still prices correctly — a runtime fetch gives neither. See
 * `scripts/generate-model-prices.mjs` for why the source is reviewed rather
 * than refreshed, and `rates.source.json` for the rates themselves.
 */

import type { ModelPricing } from '../utils/cost.js'
import { VENDOR_RATES } from './catalogue.generated.js'

export type { VendorRates } from './catalogue.generated.js'
export { VENDOR_RATES }

/** A driver that bills nothing per token resolves to this. */
const UNMETERED: ModelPricing = { inputCostPer1M: 0, outputCostPer1M: 0 }

const BY_PROVIDER = new Map(VENDOR_RATES.map((vendor) => [vendor.providerId, vendor]))

/**
 * A dated snapshot suffix, in the two shapes vendors actually ship:
 * `claude-sonnet-4-5-20250929` and `claude-opus-4-5@20251101`. Stripping it
 * is the ONLY normalisation, because a snapshot of a model is that model at
 * that model's rate — the vendor prices the family, not the date.
 */
const SNAPSHOT_SUFFIX = /[-@]\d{8}$/

/** Lowercase, snapshot suffix removed. Exported because tests assert it. */
export function normaliseModelId(model: string): string {
	return model.toLowerCase().replace(SNAPSHOT_SUFFIX, '')
}

/**
 * The rate card for a model, or `undefined` when nobody here has one.
 *
 * `undefined` is a real answer and the caller must keep it distinct from a
 * rate of zero. Zero means this run genuinely costs nothing — the local
 * drivers, which bill per token exactly never. `undefined` means the total is
 * unknowable, and a caller that flattens the two reproduces the defect this
 * whole module exists to remove, one level down.
 *
 * ## Matching is exact, and that is the point
 *
 * The neighbouring context-window table matches on longest substring, and it
 * is right to: a window guessed one size small costs a compaction pass. A rate
 * guessed one row across costs the caller money and moves their budget. Inside
 * a single vendor here, ids one character apart differ in price by 4x and by
 * 24x. So a near-miss is not a degraded answer, it is a wrong one, and this
 * returns `undefined` instead — which is safe by construction, because
 * `undefined` refuses rather than proceeds.
 *
 * The cost of exactness is stated rather than hidden: a model the vendor has
 * released since this table was reviewed is unpriced until somebody adds the
 * row. That is a visible, fixable gap. A silently wrong total is neither.
 */
export function resolveModelPricing(
	providerId: string,
	model: string | undefined,
): ModelPricing | undefined {
	const vendor = BY_PROVIDER.get(providerId)
	if (vendor === undefined) return undefined
	// Checked before the model id, deliberately. An unmetered driver bills
	// nothing whatever it is asked to run, and its models are whatever the
	// operator has pulled onto the machine — enumerable by nobody. Requiring a
	// row for each would make every local run unpriced, which would report
	// "cost unknown" about the one case where the cost is known exactly.
	if (vendor.unmetered) return UNMETERED
	if (model === undefined) return undefined
	return vendor.models.get(normaliseModelId(model))
}
