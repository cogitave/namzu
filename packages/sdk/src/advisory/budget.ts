import type { AdvisorDefinition, AdvisoryBudget } from '../types/advisory/index.js'

/**
 * Refuse a budget the runtime cannot honour.
 *
 * A cost cap is enforced against real spend, and real spend needs a price.
 * Without one every call costs zero, so the cap never trips — the host sets
 * a limit, sees no error, and learns it was decoration only from the bill.
 * Refusing at construction is the same trade the runtime makes elsewhere:
 * a configuration that cannot do what it says is an error, not a default.
 */
export function assertBudgetEnforceable(config: {
	readonly advisors: readonly AdvisorDefinition[]
	readonly budget?: AdvisoryBudget | undefined
}): void {
	if (config.budget?.maxCostPerRun === undefined) return

	const unpriced = config.advisors.filter((a) => a.pricing === undefined).map((a) => a.id)
	if (unpriced.length === 0) return

	throw new Error(
		`Advisory budget sets maxCostPerRun but ${unpriced.length === 1 ? 'advisor' : 'advisors'} ` +
			`${unpriced.join(', ')} carr${unpriced.length === 1 ? 'ies' : 'y'} no pricing, so cost ` +
			'cannot be measured and the cap could never be reached. Give each advisor a `pricing` ' +
			'entry, or drop the cost cap and bound the run with `maxCallsPerRun`.',
	)
}
