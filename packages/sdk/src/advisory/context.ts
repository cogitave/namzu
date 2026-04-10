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

	checkBudget(): { allowed: boolean; reason?: string } {
		const { remaining, total } = this.getBudgetStatus()
		if (remaining !== undefined && remaining <= 0) {
			return {
				allowed: false,
				reason: `Advisory budget exhausted: ${total} calls used of ${total} allowed per run`,
			}
		}
		return { allowed: true }
	}
}
