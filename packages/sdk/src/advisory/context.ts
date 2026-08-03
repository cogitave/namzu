import type { AdvisoryBudget, AdvisoryCallRecord } from '../types/advisory/index.js'
import type { TriggerEvaluator } from './evaluator.js'
import type { AdvisoryExecutor } from './executor.js'
import type { AdvisorRegistry } from './registry.js'

export class AdvisoryContext {
	readonly registry: AdvisorRegistry
	readonly executor: AdvisoryExecutor
	readonly evaluator: TriggerEvaluator
	readonly callHistory: AdvisoryCallRecord[] = []

	private readonly budget: AdvisoryBudget | undefined

	constructor(
		registry: AdvisorRegistry,
		executor: AdvisoryExecutor,
		evaluator: TriggerEvaluator,
		budget?: AdvisoryBudget,
	) {
		this.registry = registry
		this.executor = executor
		this.evaluator = evaluator
		this.budget = budget
	}

	recordCall(record: AdvisoryCallRecord): void {
		this.callHistory.push(record)
	}

	getBudgetStatus(): { remaining: number | undefined; total: number | undefined; used: number } {
		const used = this.callHistory.length
		const total = this.budget?.maxCallsPerRun
		const remaining = total !== undefined ? total - used : undefined
		return { remaining, total, used }
	}

	/** Advisory spend so far this run, summed from the recorded calls. */
	spentCost(): number {
		return this.callHistory.reduce((sum, call) => sum + call.cost.totalCost, 0)
	}

	checkBudget(): { allowed: boolean; reason?: string } {
		const { remaining, total } = this.getBudgetStatus()
		if (remaining !== undefined && remaining <= 0) {
			return {
				allowed: false,
				reason: `Advisory budget exhausted: ${total} calls used of ${total} allowed per run`,
			}
		}

		// Checked before the call, not after: a cap that only reports
		// overspend once it has happened is a log line, not a budget.
		const costCap = this.budget?.maxCostPerRun
		if (costCap !== undefined) {
			const spent = this.spentCost()
			if (spent >= costCap) {
				return {
					allowed: false,
					reason: `Advisory budget exhausted: cost ${spent} of ${costCap} allowed per run`,
				}
			}
		}

		return { allowed: true }
	}
}
