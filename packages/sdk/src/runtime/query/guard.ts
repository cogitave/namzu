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

	/**
	 * Absolute wall-clock deadline for the run (`guardStart + timeoutMs`),
	 * expressed as an epoch-ms timestamp. Single source of truth for the
	 * run's time budget: the model-call attempt loop reads this so a retry
	 * never runs on a second, drifting clock (ses_015 A3, round-2 M8).
	 *
	 * After {@link restoreElapsed} this shrinks by the time the run already
	 * spent in earlier segments, so a resumed run does not get a fresh full
	 * timeout.
	 */
	get deadlineAt(): number {
		return this.startTime + this.limitConfig.timeoutMs
	}

	/** Configured run timeout in milliseconds. */
	get timeoutMs(): number {
		return this.limitConfig.timeoutMs
	}

	/**
	 * Active execution time the run has consumed so far — this segment's
	 * elapsed plus whatever {@link restoreElapsed} carried in from earlier
	 * segments. This is the value a checkpoint records so the next resume can
	 * pick the clock back up; see {@link restoreElapsed} for the semantics.
	 */
	get activeElapsedMs(): number {
		return Date.now() - this.startTime
	}

	/**
	 * Carry the run's already-spent execution time into this segment's clock,
	 * by back-dating the guard's start so that `now - startTime` equals the
	 * time the run had consumed when the checkpoint was written.
	 *
	 * **`timeoutMs` measures ACTIVE EXECUTION TIME, not calendar time.** It is
	 * the sum of the run's executing segments, so a run that is checkpointed,
	 * waits three days for a human to approve a tool call, and is then resumed
	 * arrives with exactly the budget it had when it stopped — the three days
	 * cost it nothing. The alternative (calendar time since the run was first
	 * created) would make every human pause a timeout, which is not a resource
	 * limit, it is a punishment for thinking. `tokenBudget`, `costLimitUsd` and
	 * `maxIterations` are LIFETIME limits accumulated across resumes (see
	 * {@link import('../../manager/run/persistence.js').RunPersistence.restoreFromCheckpoint});
	 * `timeoutMs` is a lifetime limit too, but on the run's *own* execution,
	 * which is the only part of the clock the agent controls.
	 *
	 * Known gap (durable-pause programme): time spent inside a live segment
	 * awaiting a HITL decision — the in-process `resumeHandler` await — still
	 * burns this clock, because the segment never ended. Once pause is durable,
	 * that wait becomes the gap BETWEEN two segments and stops counting, which
	 * is the whole point of doing it this way.
	 *
	 * A negative or absent `elapsedMs` (an older checkpoint written before the
	 * field was populated) is clamped to zero rather than rewarding the run
	 * with extra time.
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
