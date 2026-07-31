import type { AdvisoryContext } from '../../../../advisory/context.js'
import type { AgentBus } from '../../../../bus/index.js'
import type { WorkingStateManager } from '../../../../compaction/manager.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import type { PlanManager } from '../../../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../../../manager/run/persistence.js'
import type { ActivityStore } from '../../../../store/activity/memory.js'
import type { TaskGateway } from '../../../../types/agent/gateway.js'
import type { WorkingMemoryProvider } from '../../../../types/agent/working-memory.js'
import type {
	HITLResumeDecision,
	IterationCheckpoint,
	ResumeHandler,
} from '../../../../types/hitl/index.js'
import type { TaskId } from '../../../../types/ids/index.js'
import type { LLMProvider } from '../../../../types/provider/index.js'
import type {
	AgentRunConfig,
	PrepareStep,
	RunEvent,
	StepResult,
	StopCondition,
} from '../../../../types/run/index.js'
import type { StructuredOutputConfig } from '../../../../types/structured-output/index.js'
import type { TaskStore } from '../../../../types/task/index.js'
import type { ToolRegistryContract } from '../../../../types/tool/index.js'
import type { Logger } from '../../../../utils/logger.js'
import type { CheckpointManager } from '../../checkpoint.js'
import type { EmitEvent } from '../../events.js'
import type { ToolExecutor } from '../../executor.js'
import type { GuardCoordinator } from '../../guard.js'

export interface LaunchedTaskMeta {
	readonly agentId: string
	readonly description: string
	readonly planTaskId?: string
	/**
	 * The `tool_use_id` of the assistant `create_task` block that
	 * spawned this background task. Required to emit the canonical
	 * `tool_result` content block when the task completes — without
	 * it we'd fall back to the legacy synthetic-user-message inject
	 * (see ses_009-task-notification-envelope). Optional because
	 * older call paths that don't thread `ToolContext.toolUseId`
	 * still publish the meta without it.
	 */
	readonly originalToolUseId?: string
}

export interface IterationContext {
	readonly provider: LLMProvider
	/**
	 * The run's `invoke_agent` span, so each iteration can parent itself to
	 * it. Explicit rather than ambient because this loop is an async
	 * generator — see `parentContext` in `telemetry/attributes.ts`.
	 */
	readonly rootSpan?: import('@opentelemetry/api').Span
	readonly runConfig: AgentRunConfig

	/**
	 * Caller-supplied halt predicate, evaluated after each step's tools have
	 * run. See {@link StopCondition}.
	 */
	readonly stopWhen?: StopCondition

	/** Called with each completed step, as it completes. */
	readonly onStepFinish?: (step: StepResult) => void

	/** Demand a schema-validated final answer. See QueryParams.structuredOutput. */
	readonly structuredOutput?: StructuredOutputConfig
	readonly tools: ToolRegistryContract
	readonly allowedTools?: string[]
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

	readonly launchedTasks: Map<TaskId, LaunchedTaskMeta>

	readonly compactionConfig?: CompactionConfig

	readonly workingStateManager?: WorkingStateManager

	readonly workingMemoryProvider?: WorkingMemoryProvider

	readonly advisoryCtx?: AdvisoryContext

	readonly agentBus?: AgentBus

	readonly verificationGate?: import('../../../../verification/gate.js').VerificationGate

	readonly pluginManager?: import('../../../../plugin/lifecycle.js').PluginLifecycleManager

	/**
	 * Override for {@link PARK_RECORD_DELAY_MS}. Internal; tests set `0` to
	 * observe a recorded park without waiting out the real threshold.
	 */
	readonly parkRecordDelayMs?: number

	/** Host hook that shapes each step before the model call. */
	readonly prepareStep?: PrepareStep
}

export type PhaseSignal = 'continue' | 'stop'

/**
 * How long a decision may take before the park is written to the store.
 *
 * A park is only worth persisting if a human is actually looking at it. An
 * `autoApproveHandler` — or any programmatic handler — answers in well
 * under a millisecond, and the iteration gate runs on EVERY iteration by
 * default, so recording every one unconditionally would take a long run
 * from one full-history checkpoint write per iteration to three. This
 * threshold buys the durability where it matters and costs nothing where
 * it does not.
 */
export const PARK_RECORD_DELAY_MS = 250

/**
 * Await a HITL decision, recording the park durably if it turns out to be
 * a real one.
 *
 * The park used to exist only as a suspended `await` inside one process:
 * kill the process and the request vanished, so a host could not rebuild
 * an approval queue and a resumed run silently re-asked the model instead
 * of honoring an approval a human had already granted.
 */
export async function awaitDecisionDurably(
	ctx: IterationContext,
	checkpoint: IterationCheckpoint,
	request: Parameters<ResumeHandler>[0],
): Promise<HITLResumeDecision> {
	const delay = ctx.parkRecordDelayMs ?? PARK_RECORD_DELAY_MS
	const decisionPromise = awaitDecisionOrAbort(ctx, request)

	let settled = false
	let recorded = false

	const record = async (): Promise<void> => {
		try {
			await ctx.checkpointMgr.park(checkpoint, request)
			recorded = true
		} catch (err) {
			// A store that cannot record the park must not take the run down
			// with it — the in-process await is still perfectly valid, it is
			// only the cross-process handoff that is lost. Loudly, though.
			ctx.log.error('Failed to record a HITL park — the run is not resumable across a restart', {
				runId: ctx.runMgr.id,
				checkpointId: checkpoint.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	const recordIfSlow = (async (): Promise<void> => {
		await sleep(delay)
		if (settled) return
		await record()
	})()

	try {
		const decision = await decisionPromise
		settled = true
		await recordIfSlow

		// `pause` is not an answer — it is "I am not answering now, hold
		// this". It therefore ALWAYS gets recorded, even when it arrived too
		// fast for the slow-park timer: a host that cannot block (a
		// serverless handler, a queue worker) answers `pause` immediately
		// and comes back in another process, which is the whole case this
		// exists for.
		if (decision.action === 'pause') {
			if (!recorded) await record()
			return decision
		}

		// Every other action resolves the park. Clearing it is what keeps an
		// approval queue from re-serving a decision that was already made.
		if (recorded) {
			await ctx.checkpointMgr.unpark(checkpoint.id, decision).catch((err: unknown) => {
				ctx.log.error('Failed to clear a recorded HITL park', {
					runId: ctx.runMgr.id,
					checkpointId: checkpoint.id,
					error: err instanceof Error ? err.message : String(err),
				})
				return null
			})
		}
		return decision
	} finally {
		settled = true
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		// A pending park recorder must never be the reason a process stays
		// alive after the run settles.
		;(timer as { unref?: () => void }).unref?.()
	})
}

/**
 * Await a HITL `resumeHandler` decision, but RACE it against the run's abort
 * signal. A Stop that arrives while the run is parked on a tool-review or
 * iteration checkpoint used to do nothing until the host eventually answered
 * (the park await was not cancellable). Racing the signal lets a Stop resolve
 * the park immediately as an `abort` decision, which `handleHITLDecision`
 * turns into `setStopReason('cancelled') + markCancelled + stop`. Fails closed:
 * a resume-handler rejection also resolves to `abort` rather than hanging.
 */
export async function awaitDecisionOrAbort(
	ctx: IterationContext,
	request: Parameters<ResumeHandler>[0],
): Promise<HITLResumeDecision> {
	const signal = ctx.abortController?.signal
	// No abort signal wired (e.g. a minimal test harness) → behave exactly as a
	// direct resumeHandler await, no race. In production RunContextFactory always
	// provides the controller, so the race below is live.
	if (!signal) return ctx.resumeHandler(request)
	const abortDecision: HITLResumeDecision = {
		action: 'abort',
		reason: 'run aborted while parked for HITL',
	}
	if (signal.aborted) return abortDecision
	return new Promise<HITLResumeDecision>((resolve) => {
		let settled = false
		const onAbort = (): void => {
			if (settled) return
			settled = true
			resolve(abortDecision)
		}
		signal.addEventListener('abort', onAbort, { once: true })
		Promise.resolve(ctx.resumeHandler(request)).then(
			(decision) => {
				if (settled) return
				settled = true
				signal.removeEventListener('abort', onAbort)
				resolve(decision)
			},
			(err) => {
				if (settled) return
				settled = true
				signal.removeEventListener('abort', onAbort)
				resolve({
					action: 'abort',
					reason: err instanceof Error ? err.message : 'resume handler failed',
				})
			},
		)
	})
}

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
				runId: ctx.runMgr.id,
				checkpointId: checkpointId as `cp_${string}`,
				reason: decision.reason,
			})
			yield* ctx.drainPending()
			ctx.runMgr.setStopReason('paused')
			ctx.log.info(`Run paused at ${context}`, {
				sessionId: ctx.runMgr.id,
				reason: decision.reason,
			})
			return 'stop'
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
		// 'answer_question' can only arrive misdirected at an iteration
		// checkpoint (answers are consumed inside the ask_user_question
		// tool's own park); treat it as a plain continue.
		case 'answer_question':
			return 'continue'
		default: {
			const _exhaustive: never = decision
			throw new Error(`Unhandled HITL decision: ${(_exhaustive as HITLResumeDecision).action}`)
		}
	}
}
