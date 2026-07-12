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
			// An iteration checkpoint parks DURABLY: its decision is persisted, so a
			// resume finds it and applies it. A plan approval does NOT, and that is a
			// deliberate refusal rather than an oversight — the checkpoint captures no
			// `PlanManager` state, so a persisted plan decision would have nothing to
			// resume into, and a pause you cannot come back to is worse than one that
			// says so. (The absent-handler default never reaches here for a plan: it
			// rejects the plan outright.) Durable plan approval waits on a PlanManager
			// restore.
			if (request.type === 'plan_approval') {
				ctx.log.warn(
					'Run paused at the plan gate — this pause is NOT durably resumable (the checkpoint does not capture plan state)',
					{ runId: ctx.runMgr.id, reason: decision.reason },
				)
				ctx.runMgr.markSuspended()
			} else {
				const pending = buildPendingDecision(request)
				await ctx.checkpointMgr.attachPendingDecision(checkpointId, pending)
				ctx.runMgr.markSuspended({ checkpointId, requestId: pending.requestId })
			}

			// Park the run BEFORE the event goes out: a listener that reads the run's
			// status on `run_paused` must not observe it as still `running`.
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
