import type { AdvisoryContext } from '../../../../advisory/context.js'
import type { AgentBus } from '../../../../bus/index.js'
import type { WorkingStateManager } from '../../../../compaction/manager.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import type { PlanManager } from '../../../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../../../manager/run/persistence.js'
import type { ToolRegistry } from '../../../../registry/tool/execute.js'
import type { ActivityStore } from '../../../../store/activity/memory.js'
import type { TaskGateway, TaskHandle } from '../../../../types/agent/gateway.js'
import type { HITLResumeDecision, ResumeHandler } from '../../../../types/hitl/index.js'
import type { TaskId } from '../../../../types/ids/index.js'
import type { LLMProvider } from '../../../../types/provider/index.js'
import type { AgentRunConfig, RunEvent } from '../../../../types/run/index.js'
import type { TaskStore } from '../../../../types/task/index.js'
import type { Logger } from '../../../../utils/logger.js'
import type { CheckpointManager } from '../../checkpoint.js'
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
	readonly sessionConfig: AgentRunConfig
	readonly tools: ToolRegistry
	readonly allowedTools?: string[]
	readonly sessionMgr: RunPersistence
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

export type PhaseSignal = 'continue' | 'stop'

export async function* handleHITLDecision(
	ctx: IterationContext,
	decision: HITLResumeDecision,
	checkpointId: string,
	context: string,
): AsyncGenerator<RunEvent, PhaseSignal> {
	switch (decision.action) {
		case 'pause': {
			await ctx.emitEvent({
				type: 'run_paused',
				runId: ctx.sessionMgr.id,
				checkpointId: checkpointId as `cp_${string}`,
				reason: decision.reason,
			})
			yield* ctx.drainPending()
			ctx.sessionMgr.setStopReason('paused')
			ctx.log.info(`Session paused at ${context}`, {
				sessionId: ctx.sessionMgr.id,
				reason: decision.reason,
			})
			return 'stop'
		}
		case 'abort': {
			ctx.sessionMgr.setStopReason('cancelled')
			ctx.sessionMgr.markCancelled()
			ctx.log.info(`Session aborted at ${context}`, {
				sessionId: ctx.sessionMgr.id,
				reason: decision.reason,
			})
			return 'stop'
		}
		case 'reject_plan': {
			ctx.sessionMgr.setStopReason('plan_rejected')
			ctx.log.info('Plan rejected by user', {
				sessionId: ctx.sessionMgr.id,
				feedback: decision.feedback,
			})
			return 'stop'
		}
		case 'approve_plan': {
			if (ctx.planManager.active) {
				ctx.planManager.approve()
				ctx.planManager.startExecution()
			}
			ctx.log.info('Plan approved by user', { sessionId: ctx.sessionMgr.id })
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
