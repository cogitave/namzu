import { type Span, SpanStatusCode } from '@opentelemetry/api'
import type { PlanManager } from '../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../manager/run/persistence.js'
import { isCallerAbortError, isProviderRequestError } from '../../provider/errors.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import { GENAI, NAMZU } from '../../telemetry/attributes.js'
import { explainError } from '../../types/errors/catalog.js'
import { toPlatformError } from '../../types/errors/index.js'
import type { CheckpointId } from '../../types/hitl/index.js'
import { cancelCauseOf } from '../../types/run/cancel-cause.js'
import type { Run, RunEvent } from '../../types/run/index.js'
import { toErrorMessage } from '../../utils/error.js'
import type { Logger } from '../../utils/logger.js'
import type { EmitEvent } from './events.js'

export interface ResultAssemblerConfig {
	runMgr: RunPersistence
	planManager: PlanManager
	activityStore: ActivityStore
	log: Logger
	emitEvent: EmitEvent
	drainPending: () => Generator<RunEvent>
	/**
	 * The state a host should resume from if the run settles recoverably.
	 *
	 * A function rather than a value: checkpoints are written per iteration,
	 * so the answer changes as the run proceeds and reading it at
	 * construction would pin the first one forever.
	 */
	resumeCheckpointId?: () => CheckpointId | undefined
	/**
	 * The run's abort signal, read only to recover WHY a cancellation
	 * happened. Optional so a caller that never cancels needs no extra
	 * wiring, and absent simply means the cause is unknown — which is the
	 * same answer an unattributed cancellation gives.
	 */
	signal?: AbortSignal
}

export class ResultAssembler {
	private config: ResultAssemblerConfig

	constructor(config: ResultAssemblerConfig) {
		this.config = config
	}

	async *completeRun(rootSpan: Span): AsyncGenerator<RunEvent> {
		const { runMgr, planManager, activityStore, log, emitEvent, drainPending } = this.config
		const cancelCause = cancelCauseOf(this.config.signal?.reason)

		if (runMgr.status === 'running') {
			runMgr.markCompleted(runMgr.stopReason)
		}

		// Settle the plan, which nothing did on this path — so a plan could
		// reach `failed` (the error path calls `failPlan`) or stay `executing`
		// forever, but never `completed`. A host reading `plan.status` after a
		// successful run saw "still running".
		//
		// Only when every step has reported, and the check is a read rather
		// than a caught throw: `completePlan` refuses an unreported step on
		// purpose, and turning a run that worked into a run that crashed on its
		// way out would be a worse version of the bug the refusal prevents.
		//
		// A plan with steps nobody reported is LEFT `executing`, which is the
		// honest answer — the caller and the plan disagree about whether the
		// work is over, and this is not the place to resolve that by guessing.
		if (planManager.isActive && planManager.unreportedSteps.length === 0) {
			planManager.completePlan()
		}

		// The run's own terminal verdict — first-class in the audit trail per
		// LOG-14, scoped deliberately: only the one outcome `AuditOutcome` can
		// name for a settled run today ('completed' → 'success'). This also
		// covers a guardrail-blocked run, which reaches `status: 'completed'`
		// via the `markCompleted` call above — "completed is not succeeded"
		// (see `types/run/events.ts`'s `run_completed` doc), and the granular
		// 'refused' entry for the block itself was already recorded at the
		// point it happened. 'cancelled'/'paused' are left unaudited here
		// rather than forced into a mapping nothing asked for — a later minor
		// can widen `AuditOutcome` additively when that scope is taken on.
		if (runMgr.status === 'completed') {
			await runMgr.recordAudit({ what: { action: 'run_completed' }, outcome: 'success' })
		}

		await emitEvent({
			type: 'run_completed',
			runId: runMgr.id,
			result: runMgr.getRun().result ?? '',
			// Read AFTER `markCompleted`, which is where a run that was stopped
			// mid-flight has its reason settled. Carried on the event so a
			// consumer can tell "answered" from "ran out of budget" without
			// holding the `Run`.
			...(runMgr.getRun().stopReason ? { stopReason: runMgr.getRun().stopReason } : {}),
			// Only on a cancellation, and only when one was recorded. Absent is
			// a real answer: a cancellation nobody attributed is not a user
			// cancellation, and defaulting would put a confident wrong value
			// where an honest gap belongs.
			...(cancelCause !== undefined ? { cancelCause } : {}),
		})
		yield* drainPending()

		rootSpan.setAttributes({
			[NAMZU.RUN_STATUS]: runMgr.stopReason ?? 'completed',
			[NAMZU.ITERATION]: runMgr.currentIteration,
			[GENAI.USAGE_INPUT_TOKENS]: runMgr.tokenUsage.promptTokens,
			[GENAI.USAGE_OUTPUT_TOKENS]: runMgr.tokenUsage.completionTokens,
		})
		rootSpan.setStatus({ code: SpanStatusCode.OK })

		log.info('Query completed', {
			[NAMZU.RUN_ID]: runMgr.id,
			'namzu.runtime.iterations': runMgr.currentIteration,
			'namzu.runtime.stop_reason': runMgr.stopReason,
			'namzu.runtime.activity_stats': activityStore.enabled ? activityStore.stats() : undefined,
		})
	}

	async *completeSession(rootSpan: Span): AsyncGenerator<RunEvent> {
		yield* this.completeRun(rootSpan)
	}

	async *handleError(err: unknown, rootSpan: Span): AsyncGenerator<RunEvent> {
		const { runMgr, planManager, log, emitEvent, drainPending } = this.config
		if (isCallerAbortError(err, this.config.signal)) {
			// Cancellation may happen before the iteration loop owns control —
			// project preparation, a run-start hook and a pre-model hook all sit
			// outside its catch. The loop already settles its own aborts, but an
			// abort escaping one of these boundaries reached the outer catch and
			// was historically rewritten as a run failure. Preserve the caller's
			// control-flow verdict and let the normal terminal-event path report it.
			runMgr.markCancelled()
			yield* this.completeRun(rootSpan)
			return
		}
		const errorMessage = toErrorMessage(err)
		// The classifier at the provider boundary already walked the cause
		// chain over status, errno and `Retry-After`, so a fully-populated
		// error arrives here — and used to be flattened to a string one line
		// later, discarding every field of it. `toPlatformError` is the
		// projection that was written for exactly this and had no callers.
		const failure = toPlatformError(err)
		// The driver's classification and the operator explanation describe the
		// throwable, not the terminal verdict. Compute them before choosing paused
		// versus failed so a recoverable run does not become the one path that
		// discards the reason and remedy a host needs in order to recover it.
		const providerError = isProviderRequestError(err)
			? {
					kind: err.kind,
					providerId: err.providerId,
					...(err.providerCode !== undefined ? { providerCode: err.providerCode } : {}),
					...(err.status !== undefined ? { status: err.status } : {}),
					...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
					// The provider's own sentence, already truncated and scrubbed
					// by the driver. Without it a host rendering this metadata
					// knows a request was rejected but not which field, and has to
					// re-parse prose to find out.
					...(err.detail !== undefined ? { detail: err.detail } : {}),
				}
			: undefined
		// Classification is structural; remediation is editorial. The catalog is
		// optional because inventing advice for an uncharacterised failure is worse
		// than presenting the reason alone.
		const explanation = explainError(err) ?? undefined

		// A transient failure that survived every in-turn recovery is not the
		// same thing as a bad API key, and settling both as `failed` gave the
		// host no way to tell them apart — recovery meant knowing about
		// checkpoints and driving replay itself. The state is already there:
		// checkpoints are written every iteration by default. Only the settle
		// and the signal were missing.
		const resumeFrom = failure.retryable ? this.config.resumeCheckpointId?.() : undefined
		if (resumeFrom !== undefined) {
			runMgr.setLastError(errorMessage)
			runMgr.setStopReason('paused')

			await emitEvent({
				type: 'run_paused',
				runId: runMgr.id,
				checkpointId: resumeFrom,
				reason: errorMessage,
				failure,
				...(providerError ? { providerError } : {}),
				...(explanation ? { explanation } : {}),
			})
			yield* drainPending()

			// OK, not ERROR: the run is resumable, and a span marked failed
			// puts it in an error dashboard it does not belong in.
			rootSpan.setAttributes({
				[NAMZU.RUN_STATUS]: 'paused',
				[NAMZU.ITERATION]: runMgr.currentIteration,
			})
			rootSpan.setStatus({ code: SpanStatusCode.OK })

			log.warn('Run paused on a recoverable failure — resume from the checkpoint', {
				[NAMZU.RUN_ID]: runMgr.id,
				'namzu.checkpoint.id': resumeFrom,
				'namzu.runtime.code': failure.code,
				'exception.message': errorMessage,
			})
			return
		}

		runMgr.markFailed(errorMessage, providerError)

		if (planManager.isActive) {
			planManager.failPlan(errorMessage)
		}

		// Same terminal-verdict recording as the success path in completeRun —
		// see LOG-14, design §5. Placed AFTER the early `resumeFrom !== undefined`
		// return above, so a paused/resumable run is never audited as 'failure'.
		await runMgr.recordAudit({
			what: { action: 'run_failed' },
			outcome: 'failure',
			reason: errorMessage,
		})

		await emitEvent({
			type: 'run_failed',
			runId: runMgr.id,
			error: errorMessage,
			failure,
			...(providerError ? { providerError } : {}),
			...(explanation ? { explanation } : {}),
		})
		yield* drainPending()

		rootSpan.setAttributes({
			[NAMZU.RUN_STATUS]: 'error',
			[NAMZU.ITERATION]: runMgr.currentIteration,
		})
		rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage })
		rootSpan.recordException(err instanceof Error ? err : new Error(errorMessage))

		log.error('Query failed', {
			[NAMZU.RUN_ID]: runMgr.id,
			'exception.message': errorMessage,
		})
	}

	async finalize(): Promise<Run> {
		await this.config.runMgr.persist()
		return this.config.runMgr.getRun()
	}
}
