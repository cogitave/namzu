import { type Span, SpanStatusCode } from '@opentelemetry/api'
import type { PlanManager } from '../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../manager/run/persistence.js'
import { isProviderRequestError } from '../../provider/errors.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import { GENAI, NAMZU } from '../../telemetry/attributes.js'
import { explainError } from '../../types/errors/catalog.js'
import { toPlatformError } from '../../types/errors/index.js'
import type { CheckpointId } from '../../types/hitl/index.js'
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
}

export class ResultAssembler {
	private config: ResultAssemblerConfig

	constructor(config: ResultAssemblerConfig) {
		this.config = config
	}

	async *completeRun(rootSpan: Span): AsyncGenerator<RunEvent> {
		const { runMgr, planManager, activityStore, log, emitEvent, drainPending } = this.config

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

		await emitEvent({
			type: 'run_completed',
			runId: runMgr.id,
			result: runMgr.getRun().result ?? '',
			// Read AFTER `markCompleted`, which is where a run that was stopped
			// mid-flight has its reason settled. Carried on the event so a
			// consumer can tell "answered" from "ran out of budget" without
			// holding the `Run`.
			...(runMgr.getRun().stopReason ? { stopReason: runMgr.getRun().stopReason } : {}),
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
			runId: runMgr.id,
			iterations: runMgr.currentIteration,
			stopReason: runMgr.stopReason,
			activityStats: activityStore.enabled ? activityStore.stats() : undefined,
		})
	}

	async *completeSession(rootSpan: Span): AsyncGenerator<RunEvent> {
		yield* this.completeRun(rootSpan)
	}

	async *handleError(err: unknown, rootSpan: Span): AsyncGenerator<RunEvent> {
		const { runMgr, planManager, log, emitEvent, drainPending } = this.config
		const errorMessage = toErrorMessage(err)
		// The classifier at the provider boundary already walked the cause
		// chain over status, errno and `Retry-After`, so a fully-populated
		// error arrives here — and used to be flattened to a string one line
		// later, discarding every field of it. `toPlatformError` is the
		// projection that was written for exactly this and had no callers.
		const failure = toPlatformError(err)

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
				runId: runMgr.id,
				checkpointId: resumeFrom,
				code: failure.code,
				error: errorMessage,
			})
			return
		}

		// The driver's classification, carried onto the run so a host can
		// branch on WHAT failed without re-parsing a sentence.
		const providerError = isProviderRequestError(err)
			? {
					kind: err.kind,
					providerId: err.providerId,
					...(err.status !== undefined ? { status: err.status } : {}),
					...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
					// The provider's own sentence, already truncated and scrubbed
					// by the driver. Without it a host rendering this metadata
					// knows a request was rejected but not which field, and has to
					// go re-parse `error` to find out — which is exactly the
					// re-parsing the line above says this exists to avoid.
					...(err.detail !== undefined ? { detail: err.detail } : {}),
				}
			: undefined
		runMgr.markFailed(errorMessage, providerError)

		if (planManager.isActive) {
			planManager.failPlan(errorMessage)
		}

		// The classification says what kind of failure it is; the catalog
		// says what a person should do about it. Keeping them separate is the
		// point — classification is structural and belongs at the boundary,
		// remediation is editorial and belongs in a list a human appends to.
		const explanation = explainError(err) ?? undefined

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
			runId: runMgr.id,
			error: errorMessage,
		})
	}

	async finalize(): Promise<Run> {
		await this.config.runMgr.persist()
		return this.config.runMgr.getRun()
	}
}
