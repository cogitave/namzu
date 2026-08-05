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

	/**
	 * Wall-clock left before this run's own timeout, never below zero.
	 *
	 * The checks above run BETWEEN iterations, so anything that waits inside
	 * one cannot be stopped by them. A caller sizing such a wait needs the
	 * number the deadline is made of rather than a constant of its own: a
	 * fixed two-minute hold measured against a run configured for twenty
	 * seconds kept it open for 120,267 ms, six times its budget, and the
	 * guard had no opportunity to object.
	 *
	 * Reads through the same `startTime` the limit checks use, so a run
	 * resumed from a checkpoint (see `restoreElapsed`) reports the time left
	 * on the RUN rather than on the process now hosting it.
	 */
	remainingMs(): number {
		return Math.max(0, this.limitConfig.timeoutMs - (Date.now() - this.startTime))
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
