import type { RunPersistence } from '../../manager/run/persistence.js'
import { buildLimitConfig, checkLimitsDetailed } from '../../run/LimitChecker.js'
import type { LimitCheckerConfig, StopReason } from '../../types/run/index.js'

export interface GuardConfig {
	tokenBudget: number
	timeoutMs: number
	costLimitUsd?: number
	maxIterations?: number
	/**
	 * Wall-clock already consumed by this run before the current process
	 * picked it up, from `IterationCheckpoint.guardState.elapsedMs`.
	 *
	 * The timeout budget is a property of the RUN, not of the process
	 * hosting it. Without the offset a run resumed from a checkpoint got a
	 * fresh clock every time, so N resumes bought N x `timeoutMs`.
	 */
	elapsedMsOffset?: number
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
		// Backdating the start is how elapsed time carries across a resume:
		// every downstream check reads `Date.now() - startTime`, so one
		// subtraction here covers the hard stop and the warning threshold
		// alike.
		this.startTime = Date.now() - Math.max(0, config.elapsedMsOffset ?? 0)
	}

	/**
	 * Adopt a checkpoint's elapsed time after construction.
	 *
	 * The guard is built before the checkpoint is read (restore is async and
	 * happens inside the run generator), so the resume path cannot pass
	 * `elapsedMsOffset` to the constructor. Rather than reorder setup around
	 * one field, let the resume branch hand it over.
	 */
	restoreElapsed(elapsedMs: number): void {
		this.startTime = Date.now() - Math.max(0, elapsedMs)
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
