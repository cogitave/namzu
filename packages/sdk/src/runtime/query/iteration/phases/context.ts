import type { AdvisoryContext } from '../../../../advisory/context.js'
import type { AgentBus } from '../../../../bus/index.js'
import type { WorkingStateManager } from '../../../../compaction/manager.js'
import type { ContextReducer } from '../../../../compaction/reducer.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import type { PlanManager } from '../../../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../../../manager/run/persistence.js'
import type { ServingMember } from '../../../../provider/fallback.js'
import type { CompletionInbox } from '../../../../scheduler/completion-inbox.js'
import type { ActivityStore } from '../../../../store/activity/memory.js'
import type { TaskScheduler } from '../../../../types/agent/scheduler.js'
import type { WorkingMemoryProvider } from '../../../../types/agent/working-memory.js'
import type {
	HITLResumeDecision,
	IterationCheckpoint,
	ResumeHandler,
} from '../../../../types/hitl/index.js'
import type { LLMProvider } from '../../../../types/provider/index.js'
import type { TaskRouterConfig } from '../../../../types/router/index.js'
import type { ReviewAnswer } from '../../../../types/run/answer-review.js'
import type {
	AgentRunConfig,
	BeforeStep,
	PrepareStepChain,
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
import type { RepeatCallTracker } from '../../repeat-call.js'
import type { SteeringChannel } from '../../steering.js'
import type { ToolGrantSet } from '../../tool-grants.js'

export interface IterationContext {
	readonly provider: LLMProvider
	/**
	 * Which chain member `provider` will route the NEXT request to.
	 *
	 * `provider` cannot answer this itself: `withProviderFallback` keeps its
	 * `id` transparently equal to the head's, deliberately, because that is
	 * what capability negotiation and the run's `gen_ai.system` attribute are
	 * about. Asking the wrapper who it is gets the declaration; this gets the
	 * observation.
	 *
	 * Optional because a host may build an `IterationContext` without a chain
	 * at all. Absent, the loop attributes each step to `provider.id` and the
	 * model it requested, which is exactly right when nothing can fall over —
	 * and exactly wrong when something can, so the wiring from `query()` is
	 * covered end-to-end rather than by a unit test on this accessor.
	 */
	readonly servingMember?: () => ServingMember
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

	/**
	 * Host verdict on the answer the run is about to settle with, and how
	 * many rejections it may spend before stopping.
	 */
	readonly reviewAnswer?: ReviewAnswer
	readonly maxAnswerReviews?: number

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

	/**
	 * Guidance a host may hand to the turn while it runs.
	 *
	 * Absent means the loop behaves exactly as it always has — nothing is
	 * drained and no tool result is extended.
	 */
	readonly steering?: SteeringChannel
	readonly checkpointMgr: CheckpointManager
	readonly planManager: PlanManager

	readonly taskGateway?: TaskScheduler

	/**
	 * Completions no call is waiting for, on their way to the transcript.
	 *
	 * Absent means the loop behaves exactly as it did before this existed:
	 * a blocking `create_task` still delivers its own result, and a
	 * completion nobody awaited is simply never mentioned.
	 */
	readonly completionInbox?: CompletionInbox

	readonly taskStore?: TaskStore

	/**
	 * Approvals a human granted earlier in this run, at a scope they chose.
	 *
	 * Consulted before a tool-review park so an already-approved call is not
	 * asked about again. Absent on paths that do not review tools.
	 */
	readonly toolGrants?: ToolGrantSet
	/**
	 * Absent when the host opted out with `repeatCallAdvisory: false`. The
	 * opt-out is the ABSENCE, not a flag read at every call site, so a code
	 * path that forgets to check the flag cannot advise anyway.
	 */
	readonly repeatCalls?: RepeatCallTracker

	/** Per-task model overrides. Consulted for the compaction summary call. */
	readonly taskRouter?: TaskRouterConfig

	readonly compactionConfig?: CompactionConfig

	/**
	 * What the driver said this model's context window is, resolved once.
	 *
	 * Carried rather than asked for, because both readers are synchronous
	 * and in the hot loop — turning either into an await would put a network
	 * round trip on every iteration of every run. `undefined` covers both
	 * "the driver has no such member" and "it asked and does not know",
	 * which are different facts to the DRIVER and the same fact here: fall
	 * through to the table.
	 */
	readonly providerContextWindow?: number

	readonly workingStateManager?: WorkingStateManager

	/**
	 * Host-supplied context reduction. Outranks `compactionConfig.strategy`
	 * and replaces the structured pass for this run.
	 */
	readonly contextReducer?: ContextReducer

	readonly workingMemoryProvider?: WorkingMemoryProvider

	readonly advisoryCtx?: AdvisoryContext

	readonly agentBus?: AgentBus

	readonly verificationGate?: import('../../../../authorization/gate.js').AuthorizationGate

	readonly pluginManager?: import('../../../../plugin/lifecycle.js').PluginLifecycleManager

	/**
	 * Override for {@link PARK_RECORD_DELAY_MS}. Internal; tests set `0` to
	 * observe a recorded park without waiting out the real threshold.
	 */
	readonly parkRecordDelayMs?: number

	/** Host hook that shapes each step before the model call. */
	readonly prepareStep?: PrepareStepChain
	readonly beforeStep?: BeforeStep
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

	// The wait for "is this park slow enough to be worth writing down", and
	// the reason it is a cancellable timer rather than a slept-through one.
	//
	// It used to `await sleep(delay)` where `sleep` created its timer and
	// UNREF'D it, so a pending recorder could never hold a process open after
	// the run settled. That is a real hazard and the intent was right, but the
	// scope was wrong: this promise is awaited *during* the run, below, on
	// every park. An unref'd timer does not keep Node's event loop alive — so
	// once the decision resolved and the run sat here waiting out the rest of
	// the delay, the loop had nothing ref'd left in it and the process exited.
	// Mid-turn. Exit code 0. Nothing written, no error, no terminal event.
	//
	// That shipped, and it made the headless surfaces unable to finish a turn
	// at all: the first tool call would complete and the process would end.
	// Every test passed because a test runner holds the loop open for the
	// whole file, which is exactly the kind of prop that hides this.
	//
	// Cancelling gets both properties. The timer is ref'd, so the run cannot
	// be killed by its own wait; and it is cleared the moment the decision
	// arrives, so nothing dangles past the run either.
	let parkTimer: ReturnType<typeof setTimeout> | undefined
	// Set SYNCHRONOUSLY when the write begins, because `recorded` only turns
	// true after it finishes — waiting on that instead would skip a write that
	// is still in flight and let the unpark below race it.
	let recording = false
	const recordIfSlow = new Promise<void>((resolve) => {
		parkTimer = setTimeout(() => {
			if (settled) {
				resolve()
				return
			}
			recording = true
			record().then(resolve, resolve)
		}, delay)
	})

	try {
		const decision = await decisionPromise
		settled = true
		// Cancel the wait rather than sitting through it. If the timer already
		// fired, `recordIfSlow` is the park write and is worth awaiting so the
		// unpark below cannot race it; if it has not, there is nothing to wait
		// for and clearing it is what lets the turn continue immediately.
		if (parkTimer !== undefined) clearTimeout(parkTimer)
		if (recording) await recordIfSlow

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
