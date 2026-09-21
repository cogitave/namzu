import type { TurnRecorder } from '../../manager/session/turn-recorder.js'
import { buildLimitConfig, checkLimitsDetailed } from '../../turn/LimitChecker.js'
import type { LimitCheckerConfig, StopReason } from '../../types/session/index.js'

export interface GuardConfig {
	tokenBudget: number
	timeoutMs: number
	costLimitUsd?: number
	maxIterations?: number
	/**
	 * Wall-clock already consumed by this turn before the current process
	 * picked it up, from the checkpoint's `guards.elapsedMs`.
	 *
	 * The timeout budget is a property of the TURN, not of the process
	 * hosting it. Without the offset a turn resumed from a checkpoint got a
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
	 * happens inside the turn generator), so the resume path cannot pass
	 * `elapsedMsOffset` to the constructor. Rather than reorder setup around
	 * one field, let the resume branch hand it over.
	 */
	restoreElapsed(elapsedMs: number): void {
		this.startTime = Date.now() - Math.max(0, elapsedMs)
	}

	/**
	 * Wall-clock left before this turn is asked to start finishing.
	 *
	 * NOT the time left before the deadline, and the difference is the whole
	 * point. The checks above run BETWEEN iterations, so anything that waits
	 * inside one cannot be stopped by them, and a caller sizing such a wait
	 * needs a number the turn actually owns: a fixed two-minute hold measured
	 * against a turn configured for twenty seconds kept it open for 120,267 ms.
	 *
	 * Measuring to the DEADLINE was the first attempt and it was wrong. The
	 * binding constraint is `budgetWarningThreshold`, the point at which this
	 * guard stops asking for more work and asks for a closing summary — that
	 * last slice exists so the turn can produce an answer, and a wait sized
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
	 * Reads through the same `startTime` the limit checks use, so a turn
	 * resumed from a checkpoint (see `restoreElapsed`) reports the time left
	 * on the TURN rather than on the process now hosting it.
	 */
	remainingBeforeFinalizeMs(): number {
		if (this.limitConfig.timeoutMs === 0) return Number.POSITIVE_INFINITY
		const finalizeAt = this.limitConfig.timeoutMs * this.limitConfig.budgetWarningThreshold
		return Math.max(0, finalizeAt - (Date.now() - this.startTime))
	}

	/**
	 * Wall-clock left before the turn's hard timeout.
	 *
	 * Setup work that happens before the first iteration cannot rely on
	 * {@link beforeIteration}: there is no iteration boundary to sample while
	 * that work is pending. Callers use this value to put the same turn-owned
	 * deadline around such work instead of inventing a second clock.
	 */
	remainingUntilTimeoutMs(): number {
		if (this.limitConfig.timeoutMs === 0) return Number.POSITIVE_INFINITY
		return Math.max(0, this.limitConfig.timeoutMs - (Date.now() - this.startTime))
	}

	beforeIteration(recorder: TurnRecorder, abortSignal: AbortSignal): GuardCheckResult {
		const limitState = {
			aborted: abortSignal.aborted,
			totalTokens: recorder.tokenUsage.totalTokens,
			totalCost: recorder.costInfo.totalCost,
			unpricedTokens: recorder.costInfo.unpricedTokens,
			currentIteration: recorder.currentIteration,
			startTime: this.startTime,
		}

		const limitResult = checkLimitsDetailed(this.limitConfig, limitState)
		if (!abortSignal.aborted && recorder.budget && recorder.budget.remaining <= 0) {
			return {
				shouldStop: true,
				forceFinalize: false,
				stopReason: 'token_budget',
				isCancelled: false,
			}
		}

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
