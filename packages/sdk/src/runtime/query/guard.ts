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
	 * Wall-clock left before this run is asked to start finishing.
	 *
	 * NOT the time left before the deadline, and the difference is the whole
	 * point. The checks above run BETWEEN iterations, so anything that waits
	 * inside one cannot be stopped by them, and a caller sizing such a wait
	 * needs a number the run actually owns: a fixed two-minute hold measured
	 * against a run configured for twenty seconds kept it open for 120,267 ms.
	 *
	 * Measuring to the DEADLINE was the first attempt and it was wrong. The
	 * binding constraint is `budgetWarningThreshold`, the point at which this
	 * guard stops asking for more work and asks for a closing summary — that
	 * last slice exists so the run can produce an answer, and a wait sized
	 * against the deadline eats into it. Half of the time-to-deadline, started
	 * just under the threshold, ends at 95% of the budget: half the closing
	 * reserve spent waiting for a result the closing answer was supposed to
	 * use.
	 *
	 * Zero once the threshold has passed, which is also how a caller gets the
	 * re-evaluation it needs: `forceFinalize` is sampled at the top of an
	 * iteration and this is read when the wait is about to start, so a long
	 * iteration that crossed the line in between is told to wait for nothing.
	 *
	 * Reads through the same `startTime` the limit checks use, so a run
	 * resumed from a checkpoint (see `restoreElapsed`) reports the time left
	 * on the RUN rather than on the process now hosting it.
	 */
	remainingBeforeFinalizeMs(): number {
		const finalizeAt = this.limitConfig.timeoutMs * this.limitConfig.budgetWarningThreshold
		return Math.max(0, finalizeAt - (Date.now() - this.startTime))
	}

	beforeIteration(runMgr: RunPersistence, abortSignal: AbortSignal): GuardCheckResult {
		const limitState = {
			aborted: abortSignal.aborted,
			totalTokens: runMgr.tokenUsage.totalTokens,
			totalCost: runMgr.costInfo.totalCost,
			unpricedTokens: runMgr.costInfo.unpricedTokens,
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
