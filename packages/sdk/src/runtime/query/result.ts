import { type Span, SpanStatusCode } from '@opentelemetry/api'
import type { PlanManager } from '../../manager/plan/lifecycle.js'
import type { TurnRecorder } from '../../manager/session/turn-recorder.js'
import { isCallerAbortError, isProviderRequestError } from '../../provider/errors.js'
import { TokenBudgetAdmissionError } from '../../provider/token-budget.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import { GENAI, NAMZU } from '../../telemetry/attributes.js'
import { explainError } from '../../types/errors/catalog.js'
import { toPlatformError } from '../../types/errors/index.js'
import type { CheckpointId } from '../../types/hitl/index.js'
import { cancelCauseOf } from '../../types/session/cancel-cause.js'
import type { SessionEvent, Turn } from '../../types/session/index.js'
import { toErrorMessage } from '../../utils/error.js'
import type { Logger } from '../../utils/logger.js'
import type { EmitEvent } from './events.js'

export interface ResultAssemblerConfig {
	recorder: TurnRecorder
	planManager: PlanManager
	activityStore: ActivityStore
	log: Logger
	emitEvent: EmitEvent
	drainPending: () => Generator<SessionEvent>
	/**
	 * The state a host should resume from if the turn settles recoverably.
	 * A function rather than a value: checkpoints are written per iteration,
	 * and a turn that fails before its first one may write one on demand.
	 */
	resumeCheckpointId?: () => CheckpointId | undefined | Promise<CheckpointId | undefined>
	/**
	 * The turn's abort signal, read only to recover WHY a cancellation
	 * happened. Absent means the cause is unknown.
	 */
	signal?: AbortSignal
}

/**
 * How a turn ends: the terminal record (`turn_completed` or `turn_failed`),
 * or `turn_paused` for a recoverable failure, with the audit entry and the
 * span verdict that go with it.
 */
export class ResultAssembler {
	private config: ResultAssemblerConfig

	constructor(config: ResultAssemblerConfig) {
		this.config = config
	}

	async *completeTurn(rootSpan: Span): AsyncGenerator<SessionEvent> {
		const { recorder, planManager, activityStore, log, emitEvent, drainPending } = this.config
		const cancelCause = cancelCauseOf(this.config.signal?.reason)

		if (recorder.status === 'running') {
			recorder.markCompleted(recorder.stopReason)
		}

		// A turn that paused on a decision ended its segment with `turn_paused`;
		// it is not settled, and a terminal record would close it for good. The
		// consumer is told the same thing the log says.
		if (recorder.isPaused) {
			rootSpan.setAttributes({
				[NAMZU.TURN_STATUS]: 'paused',
				[NAMZU.ITERATION]: recorder.currentIteration,
			})
			rootSpan.setStatus({ code: SpanStatusCode.OK })
			log.info('Turn paused; resume it once the decision is made', {
				[NAMZU.TURN_ID]: recorder.turnId,
				'namzu.runtime.iterations': recorder.currentIteration,
			})
			return
		}

		// Settle the plan once every step has reported. A plan with steps
		// nobody reported is LEFT executing: the caller and the plan disagree
		// about whether the work is over.
		if (planManager.isActive && planManager.unreportedSteps.length === 0) {
			planManager.completePlan()
		}

		// The turn's own terminal verdict, first-class in the audit trail.
		// 'completed' is not 'succeeded' (a guardrail-blocked turn lands here
		// too); the granular 'refused' entry was recorded where it happened.
		if (recorder.status === 'completed' && recorder.isActive) {
			await recorder.recordAudit({ what: { action: 'turn_completed' }, outcome: 'success' })
		}

		const turn = recorder.getTurn()
		await emitEvent({
			type: 'turn_completed',
			budget: recorder.budget?.summary(),
			result: turn.result ?? '',
			...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
			// Only on a cancellation, and only when one was recorded.
			...(cancelCause !== undefined ? { cancelCause } : {}),
			settlement: recorder.settlement(recorder.status === 'cancelled' ? 'cancelled' : 'completed'),
		})
		yield* drainPending()

		rootSpan.setAttributes({
			[NAMZU.TURN_STATUS]: recorder.stopReason ?? 'completed',
			[NAMZU.ITERATION]: recorder.currentIteration,
			[GENAI.USAGE_INPUT_TOKENS]: recorder.tokenUsage.promptTokens,
			[GENAI.USAGE_OUTPUT_TOKENS]: recorder.tokenUsage.completionTokens,
		})
		rootSpan.setStatus({ code: SpanStatusCode.OK })

		log.info('Query completed', {
			[NAMZU.TURN_ID]: recorder.turnId,
			'namzu.runtime.iterations': recorder.currentIteration,
			'namzu.runtime.stop_reason': recorder.stopReason,
			'namzu.runtime.activity_stats': activityStore.enabled ? activityStore.stats() : undefined,
		})
	}

	async *handleError(err: unknown, rootSpan: Span): AsyncGenerator<SessionEvent> {
		const { recorder, planManager, log, emitEvent, drainPending } = this.config
		if (isCallerAbortError(err, this.config.signal)) {
			// Cancellation outside the loop's own catch (preparation, a
			// turn-start hook, a pre-model hook) keeps the caller's verdict.
			recorder.markCancelled()
			yield* this.completeTurn(rootSpan)
			return
		}
		if (err instanceof TokenBudgetAdmissionError) {
			recorder.setStopReason('token_budget')
			yield* this.completeTurn(rootSpan)
			return
		}
		const errorMessage = toErrorMessage(err)
		// The provider boundary already classified this error; keep every
		// field of it rather than flattening it to a string.
		const failure = toPlatformError(err)
		const providerError = isProviderRequestError(err)
			? {
					kind: err.kind,
					providerId: err.providerId,
					...(err.providerCode !== undefined ? { providerCode: err.providerCode } : {}),
					...(err.status !== undefined ? { status: err.status } : {}),
					...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
					...(err.detail !== undefined ? { detail: err.detail } : {}),
				}
			: undefined
		const explanation = explainError(err) ?? undefined

		// A transient failure that survived every in-turn recovery pauses the
		// turn on its newest checkpoint instead of failing it: the host resumes
		// the same turn with `resumeSession`. A turn that fails before its
		// first checkpoint pauses on one of the turn where its loop began.
		const resumeFrom =
			failure.retryable && recorder.isActive ? await this.resumePoint(errorMessage) : undefined
		if (resumeFrom !== undefined) {
			// The classification a failed turn would carry: a host deciding
			// when to resume reads the retry delay from it.
			recorder.setLastError(errorMessage, providerError)
			recorder.setStopReason('paused')

			await emitEvent({
				type: 'turn_paused',
				budget: recorder.budget?.summary(),
				checkpointId: resumeFrom,
				reason: errorMessage,
				failure,
				...(providerError ? { providerError } : {}),
				...(explanation ? { explanation } : {}),
			})
			yield* drainPending()

			// OK, not ERROR: the turn is resumable.
			rootSpan.setAttributes({
				[NAMZU.TURN_STATUS]: 'paused',
				[NAMZU.ITERATION]: recorder.currentIteration,
			})
			rootSpan.setStatus({ code: SpanStatusCode.OK })

			log.warn('Turn paused on a recoverable failure — resume from the checkpoint', {
				[NAMZU.TURN_ID]: recorder.turnId,
				'namzu.checkpoint.id': resumeFrom,
				'namzu.runtime.code': failure.code,
				'exception.message': errorMessage,
			})
			return
		}

		recorder.markFailed(errorMessage, providerError)

		if (planManager.isActive) {
			planManager.failPlan(errorMessage)
		}

		// Same terminal-verdict recording as the success path; a paused turn
		// is never audited as a failure.
		if (recorder.isActive) {
			await recorder.recordAudit({
				what: { action: 'turn_failed' },
				outcome: 'failure',
				reason: errorMessage,
			})
		}

		await emitEvent({
			type: 'turn_failed',
			budget: recorder.budget?.summary(),
			error: errorMessage,
			failure,
			...(providerError ? { providerError } : {}),
			...(explanation ? { explanation } : {}),
			settlement: recorder.settlement('failed'),
		})
		yield* drainPending()

		rootSpan.setAttributes({
			[NAMZU.TURN_STATUS]: 'error',
			[NAMZU.ITERATION]: recorder.currentIteration,
		})
		rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage })
		rootSpan.recordException(err instanceof Error ? err : new Error(errorMessage))

		log.error('Query failed', {
			[NAMZU.TURN_ID]: recorder.turnId,
			'exception.message': errorMessage,
		})
	}

	/**
	 * Where a recoverable failure pauses. A checkpoint that cannot be written
	 * leaves the turn to fail with the error it actually had: a pause with
	 * nothing to resume from is a dead end, and the write failure is not what
	 * the caller needs to hear about.
	 */
	private async resumePoint(errorMessage: string): Promise<CheckpointId | undefined> {
		try {
			return await this.config.resumeCheckpointId?.()
		} catch (err) {
			this.config.log.warn('No checkpoint to pause on; the turn fails instead', {
				[NAMZU.TURN_ID]: this.config.recorder.turnId,
				'exception.message': toErrorMessage(err),
				'namzu.runtime.error': errorMessage,
			})
			return undefined
		}
	}

	/** The durable half of settling: every queued record lands, the ledger is flushed. */
	async finalize(): Promise<Turn> {
		await this.config.recorder.persist()
		return this.config.recorder.getTurn()
	}
}
