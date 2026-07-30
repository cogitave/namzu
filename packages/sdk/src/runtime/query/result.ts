import { type Span, SpanStatusCode } from '@opentelemetry/api'
import type { PlanManager } from '../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../manager/run/persistence.js'
import { isProviderRequestError } from '../../provider/errors.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import { GENAI, NAMZU } from '../../telemetry/attributes.js'
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
}

export class ResultAssembler {
	private config: ResultAssemblerConfig

	constructor(config: ResultAssemblerConfig) {
		this.config = config
	}

	async *completeRun(rootSpan: Span): AsyncGenerator<RunEvent> {
		const { runMgr, activityStore, log, emitEvent, drainPending } = this.config

		if (runMgr.status === 'running') {
			runMgr.markCompleted(runMgr.stopReason)
		}

		await emitEvent({
			type: 'run_completed',
			runId: runMgr.id,
			result: runMgr.getRun().result ?? '',
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
		const providerError = isProviderRequestError(err)
			? {
					kind: err.kind,
					providerId: err.providerId,
					...(err.status !== undefined ? { status: err.status } : {}),
					...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
				}
			: undefined
		runMgr.markFailed(errorMessage, providerError)

		if (planManager.isActive) {
			planManager.failPlan(errorMessage)
		}

		await emitEvent({
			type: 'run_failed',
			runId: runMgr.id,
			error: errorMessage,
			...(providerError ? { providerError } : {}),
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
