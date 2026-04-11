import type { RunPersistence } from '../../manager/run/persistence.js'
import { buildLimitConfig, checkLimitsDetailed } from '../../run/LimitChecker.js'
import type { LimitCheckerConfig, StopReason } from '../../types/run/index.js'

export interface GuardConfig {
	tokenBudget: number
	timeoutMs: number
	costLimitUsd?: number
	maxIterations?: number
}

export interface GuardCheckResult {
	shouldStop: boolean
	forceFinalize: boolean
	stopReason?: StopReason
	isCancelled: boolean
}

export class GuardCoordinator {
	private limitConfig: LimitCheckerConfig
	private startTime: number

	constructor(config: GuardConfig) {
		this.limitConfig = buildLimitConfig(
			config.tokenBudget,
			config.timeoutMs,
			config.costLimitUsd,
			config.maxIterations,
		)
		this.startTime = Date.now()
	}

	beforeIteration(runMgr: RunPersistence, abortSignal: AbortSignal): GuardCheckResult {
		const limitState = {
			aborted: abortSignal.aborted,
			totalTokens: runMgr.tokenUsage.totalTokens,
			totalCost: runMgr.costInfo.totalCost,
			currentIteration: runMgr.currentIteration,
			startTime: this.startTime,
		}

		const limitResult = checkLimitsDetailed(this.limitConfig, limitState)

		if (limitResult.type === 'hard_stop') {
			return {
				shouldStop: true,
				forceFinalize: false,
				stopReason: limitResult.reason,
				isCancelled: limitResult.reason === 'cancelled',
			}
		}

		if (limitResult.type === 'warning') {
			return {
				shouldStop: false,
				forceFinalize: true,
				stopReason: limitResult.reason,
				isCancelled: false,
			}
		}

		return {
			shouldStop: false,
			forceFinalize: false,
			isCancelled: false,
		}
	}
}
