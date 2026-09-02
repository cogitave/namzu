import type { LimitCheckerConfig, StopReason } from '../types/run/index.js'

export interface LimitCheckerState {
	aborted: boolean
	totalTokens: number
	totalCost: number
	/**
	 * Tokens accumulated at no known rate, from `CostInfo.unpricedTokens`.
	 *
	 * The cost checks below read `totalCost`, and `totalCost` omits whatever
	 * these cost. Without this field they cannot tell a run that has spent
	 * nothing from one whose spend was never computed, so a `costLimitUsd`
	 * silently never fires — which is what every run did, because nothing fed
	 * the cost calculation at all.
	 */
	unpricedTokens: number
	currentIteration: number
	startTime: number
}

export type LimitCheckResult =
	| { type: 'ok' }
	| { type: 'warning'; reason: StopReason }
	| { type: 'hard_stop'; reason: StopReason }

export function checkLimitsDetailed(
	config: LimitCheckerConfig,
	state: LimitCheckerState,
): LimitCheckResult {
	if (state.aborted) {
		return { type: 'hard_stop', reason: 'cancelled' }
	}

	if (Date.now() - state.startTime > config.timeoutMs) {
		return { type: 'hard_stop', reason: 'timeout' }
	}

	if (config.tokenBudget > 0 && state.totalTokens >= config.tokenBudget) {
		return { type: 'hard_stop', reason: 'token_budget' }
	}

	if (config.costLimitUsd && config.costLimitUsd > 0) {
		if (state.totalCost >= config.costLimitUsd) {
			return { type: 'hard_stop', reason: 'cost_limit' }
		}
		// Checked BEFORE the comparison can pass, not after. `totalCost` is
		// only the part of the run that had a rate, so a run whose spend is
		// partly unknown can sit under any limit forever while spending without
		// bound. Continuing here would be the check answering "the budget is
		// satisfied" to the question "can the budget be evaluated?", which is
		// the strongest available wrong answer — see
		// "an optional dependency may not degrade a check".
		if (state.unpricedTokens > 0) {
			return { type: 'hard_stop', reason: 'cost_unmeasurable' }
		}
	}

	if (state.currentIteration >= config.maxIterations) {
		return { type: 'hard_stop', reason: 'max_iterations' }
	}

	if (config.tokenBudget > 0) {
		const usageRatio = state.totalTokens / config.tokenBudget
		if (usageRatio >= config.budgetWarningThreshold) {
			return { type: 'warning', reason: 'token_budget' }
		}
	}

	if (config.costLimitUsd && config.costLimitUsd > 0) {
		const costRatio = state.totalCost / config.costLimitUsd
		if (costRatio >= config.budgetWarningThreshold) {
			return { type: 'warning', reason: 'cost_limit' }
		}
	}

	const timeElapsed = Date.now() - state.startTime
	const timeRatio = timeElapsed / config.timeoutMs
	if (timeRatio >= config.budgetWarningThreshold) {
		return { type: 'warning', reason: 'timeout' }
	}

	return { type: 'ok' }
}

export function buildLimitConfig(
	tokenBudget: number,
	timeoutMs: number,
	costLimitUsd?: number,
	maxIterations?: number,
	budgetWarningThreshold?: number,
): LimitCheckerConfig {
	return {
		tokenBudget,
		timeoutMs,
		costLimitUsd,
		maxIterations: maxIterations ?? 200,
		budgetWarningThreshold: budgetWarningThreshold ?? 0.9,
	}
}
