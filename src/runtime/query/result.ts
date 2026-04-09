import { SpanStatusCode } from '@opentelemetry/api'
import type { Span } from '@opentelemetry/api'
import type { PlanManager } from '../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../manager/run/persistence.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import { GENAI, NAMZU } from '../../telemetry/attributes.js'
import type { AgentRun, RunEvent } from '../../types/run/index.js'
import { toErrorMessage } from '../../utils/error.js'
import type { Logger } from '../../utils/logger.js'
import type { EmitEvent } from './events.js'

export interface ResultAssemblerConfig {
	sessionMgr: RunPersistence
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
		const { sessionMgr, activityStore, log, emitEvent, drainPending } = this.config

		if (sessionMgr.status === 'running') {
			sessionMgr.markCompleted(sessionMgr.stopReason)
		}

		await emitEvent({
			type: 'run_completed',
			runId: sessionMgr.id,
			result: sessionMgr.getRun().result ?? '',
		})
		yield* drainPending()

		rootSpan.setAttributes({
			[NAMZU.SESSION_STATUS]: sessionMgr.stopReason ?? 'completed',
			[NAMZU.ITERATION]: sessionMgr.currentIteration,
			[GENAI.USAGE_INPUT_TOKENS]: sessionMgr.tokenUsage.promptTokens,
			[GENAI.USAGE_OUTPUT_TOKENS]: sessionMgr.tokenUsage.completionTokens,
		})
		rootSpan.setStatus({ code: SpanStatusCode.OK })

		log.info('Query completed', {
			runId: sessionMgr.id,
			iterations: sessionMgr.currentIteration,
			stopReason: sessionMgr.stopReason,
			activityStats: activityStore.enabled ? activityStore.stats() : undefined,
		})
	}

	async *completeSession(rootSpan: Span): AsyncGenerator<RunEvent> {
		yield* this.completeRun(rootSpan)
	}

	async *handleError(err: unknown, rootSpan: Span): AsyncGenerator<RunEvent> {
		const { sessionMgr, planManager, log, emitEvent, drainPending } = this.config
		const errorMessage = toErrorMessage(err)
		sessionMgr.markFailed(errorMessage)

		if (planManager.isActive) {
			planManager.failPlan(errorMessage)
		}

		await emitEvent({
			type: 'run_failed',
			runId: sessionMgr.id,
			error: errorMessage,
		})
		yield* drainPending()

		rootSpan.setAttributes({
			[NAMZU.SESSION_STATUS]: 'error',
			[NAMZU.ITERATION]: sessionMgr.currentIteration,
		})
		rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage })
		rootSpan.recordException(err instanceof Error ? err : new Error(errorMessage))

		log.error('Query failed', {
			runId: sessionMgr.id,
			error: errorMessage,
		})
	}

	async finalize(): Promise<AgentRun> {
		await this.config.sessionMgr.persist()
		return this.config.sessionMgr.getRun()
	}
}
