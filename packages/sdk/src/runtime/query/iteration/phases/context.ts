import type { AdvisoryContext } from '../../../../advisory/context.js'
import type { AgentBus } from '../../../../bus/index.js'
import type { WorkingStateManager } from '../../../../compaction/manager.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import type { PlanManager } from '../../../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../../../manager/run/persistence.js'
import type { ActivityStore } from '../../../../store/activity/memory.js'
import type { TaskGateway, TaskHandle } from '../../../../types/agent/gateway.js'
import type {
	HITLDecisionRequest,
	HITLResumeDecision,
	ResumeHandler,
} from '../../../../types/hitl/index.js'
import type { TaskId } from '../../../../types/ids/index.js'
import type { LLMProvider } from '../../../../types/provider/index.js'
import type { AgentRunConfig, RunEvent } from '../../../../types/run/index.js'
import type { TaskStore } from '../../../../types/task/index.js'
import type { ToolRegistryContract } from '../../../../types/tool/index.js'
import type { Logger } from '../../../../utils/logger.js'
import type { CheckpointManager } from '../../checkpoint.js'
import { buildPendingDecision } from '../../decision/pending.js'
import type { EmitEvent } from '../../events.js'
import type { ToolExecutor } from '../../executor.js'
import type { GuardCoordinator } from '../../guard.js'

export interface LaunchedTaskMeta {
	readonly agentId: string
	readonly description: string
	readonly planTaskId?: string
}

export interface IterationContext {
	readonly provider: LLMProvider
	readonly runConfig: AgentRunConfig
	readonly tools: ToolRegistryContract
	readonly allowedTools?: string[]

	/**
	 * Per-run token stamped into the tag names of every frame the runtime pushes
	 * into the conversation (`<task-notification-{nonce}>`, `<advisory-result-{nonce}>`).
	 * The system prompt tells the model that only tags bearing it are
	 * framework-authored, which is what lets the content inside a frame stay
	 * verbatim: forging the boundary now requires guessing the nonce, so the
	 * payload no longer has to be escaped to be safe.
	 */
	readonly frameNonce: string
	readonly runMgr: RunPersistence
	readonly toolExecutor: ToolExecutor
	readonly guard: GuardCoordinator
	readonly activityStore: ActivityStore
	readonly emitEvent: EmitEvent
	readonly drainPending: () => Generator<RunEvent>
	readonly abortController: AbortController
	readonly log: Logger
	readonly resumeHandler: ResumeHandler
	readonly checkpointMgr: CheckpointManager
	readonly planManager: PlanManager

	readonly taskGateway?: TaskGateway

	readonly taskStore?: TaskStore

	readonly pendingNotifications: TaskHandle[]

	readonly launchedTasks: Map<TaskId, LaunchedTaskMeta>

	readonly compactionConfig?: CompactionConfig

	readonly workingStateManager?: WorkingStateManager

	readonly advisoryCtx?: AdvisoryContext

	readonly agentBus?: AgentBus

	readonly verificationGate?: import('../../../../verification/gate.js').VerificationGate

	readonly pluginManager?: import('../../../../plugin/lifecycle.js').PluginLifecycleManager
}

/**
 * How a phase wants the loop to proceed.
 *
 * `stop` and `suspend` both end the loop, and conflating them is what made a
 * paused run indistinguishable from a finished one: `pause` and `abort` both
 * returned `stop`, so the only trace of the difference was a `stopReason`
 * nobody downstream consulted. They are now separate signals, and the loop
 * turns them into separate {@link import('../../../../types/run/disposition.js').RunDisposition}s.
 */
export type PhaseSignal = 'continue' | 'stop' | 'suspend'

export async function* handleHITLDecision(
	ctx: IterationContext,
	decision: HITLResumeDecision,
	request: HITLDecisionRequest,
	context: string,
): AsyncGenerator<RunEvent, PhaseSignal> {
	const checkpointId = request.checkpointId

	switch (decision.action) {
		case 'pause': {
			// A plan approval cannot park DURABLY, and pretending otherwise produced a run
			// that was neither terminal nor resumable — the third state, and the worst one.
			// The checkpoint captures no `PlanManager`, so a persisted plan decision would
			// have nothing to resume INTO: the resumed run rebuilds an empty PlanManager,
			// never re-fires the gate, and `approve_plan` would be recorded against a plan
			// that no longer exists. Parking without a decision was worse still — nothing
			// could answer the run at all, `resumeDecision` threw `DecisionNotFoundError`
			// forever, and `deriveStatus` reported the whole Session as awaiting a human
			// who had no way to reply.
			//
			// So it STOPS, which is what it did before ses_017 and is the honest answer:
			// this pause cannot be come back to, and a run that says so beats a run that
			// waits for a message that can never arrive. Durable plan approval waits on a
			// PlanManager restore (ses_017 open questions).
			if (request.type === 'plan_approval') {
				ctx.log.warn(
					'Pause at the plan gate is NOT durably resumable (the checkpoint captures no plan state) — ending the run instead of parking it on a decision nothing can answer',
					{ runId: ctx.runMgr.id, reason: decision.reason },
				)
				ctx.runMgr.setStopReason('paused')
				return 'stop'
			}

			const pending = buildPendingDecision(request)
			await ctx.checkpointMgr.attachPendingDecision(checkpointId, pending)

			// Park the run BEFORE the event goes out: a listener that reads the run's
			// status on `run_paused` must not observe it as still `running`. The park is a
			// WRITE — the suspension is persisted here, not at finalize, so a process that
			// dies in between leaves a run that can still be answered.
			await ctx.runMgr.markSuspended({ checkpointId, requestId: pending.requestId })

			await ctx.emitEvent({
				type: 'run_paused',
				runId: ctx.runMgr.id,
				checkpointId,
				reason: decision.reason,
			})
			yield* ctx.drainPending()
			ctx.log.info(`Run paused at ${context}`, {
				sessionId: ctx.runMgr.id,
				reason: decision.reason,
			})
			return 'suspend'
		}
		case 'abort': {
			ctx.runMgr.setStopReason('cancelled')
			ctx.runMgr.markCancelled()
			ctx.log.info(`Run aborted at ${context}`, {
				sessionId: ctx.runMgr.id,
				reason: decision.reason,
			})
			return 'stop'
		}
		case 'reject_plan': {
			ctx.runMgr.setStopReason('plan_rejected')
			ctx.log.info('Plan rejected by user', {
				sessionId: ctx.runMgr.id,
				feedback: decision.feedback,
			})
			return 'stop'
		}
		case 'approve_plan': {
			if (ctx.planManager.active) {
				ctx.planManager.approve()
				ctx.planManager.startExecution()
			}
			ctx.log.info('Plan approved by user', { sessionId: ctx.runMgr.id })
			return 'continue'
		}
		case 'continue':
		case 'approve_tools':
		case 'modify_tools':
		case 'reject_tools':
			return 'continue'
		default: {
			const _exhaustive: never = decision
			throw new Error(`Unhandled HITL decision: ${(_exhaustive as HITLResumeDecision).action}`)
		}
	}
}
