import type {
	AdvisoryBudget,
	AdvisoryTrigger,
	TriggerCondition,
	TriggerEvaluationState,
} from '../types/advisory/index.js'

function assertNever(value: never): never {
	throw new Error(`Unhandled trigger condition type: ${(value as TriggerCondition).type}`)
}

export class TriggerEvaluator {
	private readonly triggers: AdvisoryTrigger[]
	private readonly budget: AdvisoryBudget | undefined
	private readonly lastFiredMap: Map<string, number> = new Map()
	private callCount = 0

	constructor(triggers: AdvisoryTrigger[], budget?: AdvisoryBudget) {
		this.triggers = triggers
			.filter((t) => t.enabled !== false)
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
		this.budget = budget
	}

	evaluate(state: TriggerEvaluationState): AdvisoryTrigger[] {
		if (this.isBudgetExhausted()) {
			return []
		}

		const fired: AdvisoryTrigger[] = []
		for (const trigger of this.triggers) {
			if (!this.isCooldownSatisfied(trigger, state.iteration)) {
				continue
			}
			if (this.matchesCondition(trigger.condition, state)) {
				fired.push(trigger)
			}
		}
		return fired
	}

	recordFiring(triggerId: string, iteration: number): void {
		this.lastFiredMap.set(triggerId, iteration)
		this.callCount++
	}

	private isBudgetExhausted(): boolean {
		if (this.budget?.maxCallsPerRun === undefined) {
			return false
		}
		return this.callCount >= this.budget.maxCallsPerRun
	}

	private isCooldownSatisfied(trigger: AdvisoryTrigger, currentIteration: number): boolean {
		if (trigger.cooldownIterations === undefined) {
			return true
		}
		const lastFired = this.lastFiredMap.get(trigger.id)
		if (lastFired === undefined) {
			return true
		}
		return currentIteration - lastFired >= trigger.cooldownIterations
	}

	private matchesCondition(condition: TriggerCondition, state: TriggerEvaluationState): boolean {
		switch (condition.type) {
			case 'on_error': {
				if (state.lastError === undefined) return false
				if (condition.categories && condition.categories.length > 0) {
					return condition.categories.some((cat) => state.lastError?.includes(cat))
				}
				return true
			}
			case 'on_iteration': {
				return state.iteration % condition.everyN === 0
			}
			case 'on_context_percent': {
				return state.contextWindowPercent >= condition.threshold
			}
			case 'on_tool_category': {
				if (state.lastToolCategory === undefined) return false
				return condition.categories.includes(state.lastToolCategory)
			}
			case 'on_cost_percent': {
				if (state.costBudgetPercent === undefined) return false
				return state.costBudgetPercent >= condition.threshold
			}
			case 'on_complexity': {
				return state.totalToolCalls >= condition.toolCallThreshold
			}
			case 'custom': {
				return condition.predicate(state)
			}
			default:
				return assertNever(condition)
		}
	}
}
