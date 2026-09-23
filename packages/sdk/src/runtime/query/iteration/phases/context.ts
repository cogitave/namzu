import type { AdvisoryContext } from '../../../../advisory/context.js'
import type { AgentBus } from '../../../../bus/index.js'
import type { WorkingStateManager } from '../../../../compaction/manager.js'
import type { ContextReducer } from '../../../../compaction/reducer.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import { NAMZU } from '../../../../constants/telemetry/index.js'
import type { PlanManager } from '../../../../manager/plan/lifecycle.js'
import type { TurnRecorder } from '../../../../manager/session/turn-recorder.js'
import type { PromptContributionRegistry } from '../../../../prompt/contributions.js'
import type { ResolvedProviderCapabilities } from '../../../../provider/capabilities.js'
import type { ServingMember } from '../../../../provider/fallback.js'
import type { CompletionInbox } from '../../../../scheduler/completion-inbox.js'
import type { ActivityStore } from '../../../../store/activity/memory.js'
import type { TaskScheduler } from '../../../../types/agent/scheduler.js'
import type { WorkingMemoryProvider } from '../../../../types/agent/working-memory.js'
import type { HITLResumeDecision, ResumeHandler } from '../../../../types/hitl/index.js'
import type { CheckpointId } from '../../../../types/ids/index.js'
import type { LLMProvider } from '../../../../types/provider/index.js'
import type { TaskRouterConfig } from '../../../../types/router/index.js'
import type { ReviewAnswer } from '../../../../types/session/answer-review.js'
import type {
	BeforeStep,
	PrepareStepChain,
	PrepareStepContext,
	SessionEvent,
	StepResult,
	StopCondition,
	TurnConfig,
} from '../../../../types/session/index.js'
import type { StructuredOutputConfig } from '../../../../types/structured-output/index.js'
import type { TaskStore } from '../../../../types/task/index.js'
import type { ToolRegistryContract } from '../../../../types/tool/index.js'
import type { Logger } from '../../../../utils/logger.js'
import type { AwaitedJobs } from '../../../jobs/awaited-jobs.js'
import type { CheckpointManager } from '../../checkpoint.js'
import type { EmitEvent } from '../../events.js'
import type { ToolExecutor } from '../../executor.js'
import type { GuardCoordinator } from '../../guard.js'
import type { ProjectInstructionContext } from '../../project-instructions.js'
import type { RepeatCallTracker } from '../../repeat-call.js'
import type { SteeringChannel } from '../../steering.js'
import type { ToolGrantSet } from '../../tool-grants.js'

export interface IterationContext {
	readonly provider: LLMProvider
	/**
	 * The turn runs in a delegated child session. A tool's request for a
	 * person then fails the turn instead of pausing it: nobody is watching
	 * a child to resume it, and its parent is waiting on a result.
	 */
	readonly delegated?: boolean
	/** Driver-level request shapes negotiated for this turn. */
	readonly providerCapabilities?: ResolvedProviderCapabilities
	/** Refuse a capability mismatch instead of emitting a warning and degrading. */
	readonly strictCapabilities?: boolean
	/**
	 * Which chain member `provider` will route the NEXT request to.
	 *
	 * `provider` cannot answer this itself: `withProviderFallback` keeps its
	 * `id` transparently equal to the head's, deliberately, because that is
	 * what capability negotiation and the turn's `gen_ai.system` attribute are
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
	 * The turn's `invoke_agent` span, so each iteration can parent itself to
	 * it. Explicit rather than ambient because this loop is an async
	 * generator — see `parentContext` in `telemetry/attributes.ts`.
	 */
	readonly rootSpan?: import('@opentelemetry/api').Span
	readonly turnConfig: TurnConfig

	/**
	 * Caller-supplied halt predicate, evaluated after each step's tools have
	 * run. See {@link StopCondition}.
	 */
	readonly stopWhen?: StopCondition

	/**
	 * Host verdict on the answer the turn is about to settle with, and how
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
	readonly recorder: TurnRecorder
	readonly toolExecutor: ToolExecutor
	readonly guard: GuardCoordinator
	readonly activityStore: ActivityStore
	readonly emitEvent: EmitEvent
	readonly drainPending: () => Generator<SessionEvent>
	readonly abortController: AbortController
	readonly log: Logger
	readonly resumeHandler: ResumeHandler

	/**
	 * The policy change the model has not been told about, if there is one.
	 *
	 * Read-and-CLEAR: calling this marks the change announced, so the caller
	 * must be the one that actually puts it in front of the model. Optional
	 * because a host driving the phases directly may have no policy box, and
	 * a turn with no changes to report behaves identically either way.
	 */
	readonly takeApprovalPolicyChange?: () =>
		| import('../../../../types/hitl/policy.js').ApprovalPolicyChange
		| undefined

	/**
	 * Contributions that report state changing DURING the turn.
	 *
	 * Rendered once per iteration, never into the system prompt: `turn`
	 * into the ephemeral trailing system message, `context` into the
	 * request-only context channel after the history — see
	 * `PromptPlacement`'s notes on both.
	 */
	readonly promptContributions?: PromptContributionRegistry

	/**
	 * Guidance a host may hand to the turn while it runs.
	 *
	 * Absent means the loop behaves exactly as it always has — nothing is
	 * drained and no tool result is extended.
	 */
	readonly steering?: SteeringChannel
	/** Records operator intent only after guidance was accepted by a tool result. */
	readonly onSteeringDelivered?: (text: string) => void
	/** Exit notices for the turn's background jobs, drained into the next tool result. */
	readonly jobNotices?: SteeringChannel
	/**
	 * Background jobs the model said it is waiting on, which is the only kind
	 * the loop holds a finishing run open for.
	 *
	 * Absent means the loop behaves exactly as it did before this existed: a
	 * job's exit still reaches the model as a notice on the next tool result,
	 * and a turn whose model stopped calling tools settles without waiting.
	 */
	readonly awaitedJobs?: AwaitedJobs
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
	 * Approvals a human granted earlier in this turn, at a scope they chose.
	 *
	 * Consulted before a tool-review park so an already-approved call is not
	 * asked about again. Absent on paths that do not review tools.
	 */
	readonly toolGrants?: ToolGrantSet
	/** See `QueryParams.reviewAllowedCalls`. Absent: allowed and granted batches skip review. */
	readonly reviewAllowedCalls?: () => boolean
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
	 * round trip on every iteration of every turn. `undefined` covers both
	 * "the driver has no such member" and "it asked and does not know",
	 * which are different facts to the DRIVER and the same fact here: fall
	 * through to the table.
	 */
	readonly providerContextWindow?: number
	/** Selected request model; its window must not reuse another model's metadata. */
	contextModel?: string
	activeProviderContextWindow?: number
	/** Bounded, run-cached provider metadata lookup for a newly selected model. */
	readonly resolveModelContextWindow?: (model: string) => Promise<number | undefined>

	/**
	 * Text queued for this turn since its last turn.
	 *
	 * Drained at the iteration boundary — the same seam `completionInbox`
	 * uses, which is the established place for putting a user message in
	 * after tool results and before the next turn.
	 */
	readonly inboundMessages?: () => readonly import('../../../../types/message/index.js').Message[]
	/** Known topic-queue arrivals appended after the restored checkpoint history. */
	readonly resumedInput?: readonly import('../../../../types/message/index.js').Message[]
	/** Observes pending input without draining it; abort releases the waiter. */
	readonly waitForInbound?: (signal: AbortSignal) => Promise<void>

	/** Live project policy; separate from human inbound continuation. */
	readonly projectInstructionContext?: ProjectInstructionContext

	readonly workingStateManager?: WorkingStateManager

	/**
	 * Host-supplied context reduction. Outranks `compactionConfig.strategy`
	 * and replaces the structured pass for this turn.
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
	readonly captureSessionEvidence?: PrepareStepContext['captureSessionEvidence']
	readonly beforeStep?: BeforeStep
}

export type PhaseSignal = 'continue' | 'stop'

/**
 * How long a decision may take before the park is written to the store.
 *
 * A park is only worth persisting if a human is actually looking at it. An
 * `autoApproveHandler` — or any programmatic handler — answers in well
 * under a millisecond, and the iteration gate runs on EVERY iteration by
 * default, so recording every one unconditionally would take a long turn
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
 * an approval queue and a resumed turn silently re-asked the model instead
 * of honoring an approval a human had already granted.
 */
export async function awaitDecisionDurably(
	ctx: IterationContext,
	checkpoint: { readonly id: CheckpointId },
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
			// A store that cannot record the park must not take the turn down
			// with it — the in-process await is still perfectly valid, it is
			// only the cross-process handoff that is lost. Loudly, though.
			ctx.log.error('Failed to record a HITL park — the turn is not resumable across a restart', {
				[NAMZU.TURN_ID]: ctx.recorder.turnId,
				'namzu.checkpoint.id': checkpoint.id,
				'exception.message': err instanceof Error ? err.message : String(err),
			})
		}
	}

	// The wait for "is this park slow enough to be worth writing down", and
	// the reason it is a cancellable timer rather than a slept-through one.
	//
	// It used to `await sleep(delay)` where `sleep` created its timer and
	// UNREF'D it, so a pending recorder could never hold a process open after
	// the turn settled. That is a real hazard and the intent was right, but the
	// scope was wrong: this promise is awaited *during* the turn, below, on
	// every park. An unref'd timer does not keep Node's event loop alive — so
	// once the decision resolved and the turn sat here waiting out the rest of
	// the delay, the loop had nothing ref'd left in it and the process exited.
	// Mid-turn. Exit code 0. Nothing written, no error, no terminal event.
	//
	// That shipped, and it made the headless surfaces unable to finish a turn
	// at all: the first tool call would complete and the process would end.
	// Every test passed because a test runner holds the loop open for the
	// whole file, which is exactly the kind of prop that hides this.
	//
	// Cancelling gets both properties. The timer is ref'd, so the turn cannot
	// be killed by its own wait; and it is cleared the moment the decision
	// arrives, so nothing dangles past the turn either.
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
					[NAMZU.TURN_ID]: ctx.recorder.turnId,
					'namzu.checkpoint.id': checkpoint.id,
					'exception.message': err instanceof Error ? err.message : String(err),
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
 * Await a HITL `resumeHandler` decision, but RACE it against the turn's abort
 * signal. A Stop that arrives while the turn is parked on a tool-review or
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
	// direct resumeHandler await, no race. In production TurnContextFactory always
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
	// `CheckpointId`, not `string`. Both callers already hold one — they pass
	// the created checkpoint's `id` — so the parameter was widened for nothing and
	// the widening is what forced the `as \`cp_${string}\`` cast below. A
	// narrower parameter costs no caller anything and makes the cast
	// unnecessary rather than merely shorter.
	checkpointId: CheckpointId,
	context: string,
): AsyncGenerator<SessionEvent, PhaseSignal> {
	switch (decision.action) {
		case 'pause': {
			await ctx.emitEvent({
				type: 'turn_paused',
				turnId: ctx.recorder.turnId,
				checkpointId,
				reason: decision.reason,
			})
			yield* ctx.drainPending()
			ctx.recorder.setStopReason('paused')
			ctx.log.info('Turn paused', {
				'namzu.turn.phase': context,
				[NAMZU.TURN_ID]: ctx.recorder.turnId,
				'namzu.runtime.reason': decision.reason,
			})
			return 'stop'
		}
		case 'abort': {
			ctx.recorder.setStopReason('cancelled')
			ctx.recorder.markCancelled()
			ctx.log.info('Turn aborted', {
				'namzu.turn.phase': context,
				[NAMZU.TURN_ID]: ctx.recorder.turnId,
				'namzu.runtime.reason': decision.reason,
			})
			return 'stop'
		}
		case 'reject_plan': {
			ctx.recorder.setStopReason('plan_rejected')
			ctx.log.info('Plan rejected by user', {
				[NAMZU.TURN_ID]: ctx.recorder.turnId,
				'namzu.runtime.feedback': decision.feedback,
			})
			return 'stop'
		}
		case 'approve_plan': {
			if (ctx.planManager.active) {
				ctx.planManager.approve()
				ctx.planManager.startExecution()
			}
			ctx.log.info('Plan approved by user', { [NAMZU.TURN_ID]: ctx.recorder.turnId })
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
