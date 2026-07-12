import type { HITLDecisionRequest, ToolCallSummary } from '../../../../types/hitl/index.js'
import { createToolMessage, createUserMessage } from '../../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { RunEvent } from '../../../../types/run/index.js'
import { generateDecisionRequestId } from '../../../../utils/id.js'
import type { VerificationGate } from '../../../../verification/index.js'
import { gateDenialOutput } from '../../../../verification/index.js'
import {
	type ProviderToolCall,
	type ReviewableCall,
	applyReviewOutcome,
	evaluateGate,
} from '../../decision/apply.js'
import { buildPendingDecision } from '../../decision/pending.js'
import type { IterationContext } from './context.js'

interface VerificationAwareContext extends IterationContext {
	readonly verificationGate?: VerificationGate
}

/**
 * `stop` ends the run for good (the human aborted it). `suspend` parks it
 * awaiting a decision that has not arrived yet — the run is not over and must
 * not be terminalized. See {@link import('./context.js').PhaseSignal}.
 */
export type ToolReviewOutcome = 'executed' | 'rejected' | 'stop' | 'suspend'

export async function* runToolReview(
	ctx: VerificationAwareContext,
	response: ChatCompletionResponse,
	iterationNum: number,
): AsyncGenerator<RunEvent, ToolReviewOutcome> {
	const toolCalls = response.message.toolCalls
	if (!toolCalls || toolCalls.length === 0) {
		return 'executed'
	}

	/**
	 * The only way out of this phase into the executor. It rebuilds the response
	 * around the calls it is handed, so a call that is not in that list cannot
	 * ride along inside `response` — which is exactly how the denied half of a
	 * mixed batch used to execute on `approve_tools`.
	 */
	const executeCalls = async (calls: readonly ProviderToolCall[]): Promise<void> => {
		const batch = await ctx.toolExecutor.executeBatch({
			...response,
			message: { ...response.message, toolCalls: [...calls] },
		})
		for (const msg of batch.messages) {
			ctx.runMgr.pushMessage(msg)
		}
	}

	let reviewable: ReviewableCall[] = toolCalls.map((call) => {
		let input: unknown
		try {
			input = JSON.parse(call.function.arguments)
		} catch {
			input = call.function.arguments
		}
		const tool = ctx.tools.get(call.function.name)
		const isDestructive = tool?.isDestructive ? tool.isDestructive(input) : false

		return {
			call,
			summary: { id: call.id, name: call.function.name, input, isDestructive },
			decision: 'review' as const,
		}
	})

	if (ctx.verificationGate) {
		const gate = ctx.verificationGate
		const evaluated = reviewable.map((rc) => ({
			rc,
			result: evaluateGate(gate, ctx.tools, ctx.log, rc.summary.name, rc.summary.input),
		}))

		const denied = evaluated.filter((e) => e.result.decision === 'deny')

		// Denied calls leave the batch here, before the human sees it. They are
		// answered now so the assistant/tool pair stays provider-valid.
		for (const { rc, result } of denied) {
			ctx.log.warn('Verification gate: tool call denied — removed from batch before review', {
				tool: rc.summary.name,
				reason: result.reason,
			})
			ctx.runMgr.pushMessage(
				createToolMessage(gateDenialOutput(rc.summary.name, result.reason), rc.call.id),
			)
		}

		reviewable = evaluated
			.filter((e) => e.result.decision !== 'deny')
			.map(({ rc, result }) => ({
				...rc,
				decision: result.decision === 'allow' ? ('allow' as const) : ('review' as const),
			}))

		if (reviewable.length === 0) {
			const reasons = denied.map((d) => `${d.rc.summary.name}: ${d.result.reason}`).join('; ')
			ctx.runMgr.pushMessage(
				createUserMessage(`[SYSTEM] Tool calls blocked by verification gate: ${reasons}`),
			)
			return 'rejected'
		}

		if (reviewable.every((rc) => rc.decision === 'allow')) {
			ctx.log.debug('Verification gate: all remaining tool calls pre-approved', {
				tools: reviewable.map((rc) => rc.summary.name),
			})
			await executeCalls(reviewable.map((rc) => rc.call))
			return 'executed'
		}

		ctx.log.debug('Verification gate: mixed decisions, proceeding to review', {
			decisions: reviewable.map((rc) => ({ tool: rc.summary.name, decision: rc.decision })),
		})
	}

	const reviewCheckpoint = await ctx.checkpointMgr.create(
		ctx.runMgr,
		iterationNum,
		ctx.guard.activeElapsedMs,
	)
	const pendingSummaries: ToolCallSummary[] = reviewable.map((rc) => rc.summary)

	// The id is minted whether or not the run ends up parking, and it is the SAME id the
	// request carries into the persisted decision and out again on every re-emission. A
	// durable pause that re-identified its own question on each resume would make an
	// idempotent client answer it twice.
	const request: HITLDecisionRequest = {
		type: 'tool_review',
		requestId: generateDecisionRequestId(),
		runId: ctx.runMgr.id,
		checkpointId: reviewCheckpoint.id,
		toolCalls: pendingSummaries,
	}

	await ctx.emitEvent({
		type: 'tool_review_requested',
		runId: ctx.runMgr.id,
		requestId: request.requestId,
		checkpointId: reviewCheckpoint.id,
		toolCalls: pendingSummaries,
		iteration: iterationNum,
	})
	yield* ctx.drainPending()

	// The in-process fast path. An embedder with a synchronous reviewer awaits here and
	// gets exactly the behaviour it always did — nothing below this line changes for it.
	// Durable pause is what happens when nobody answers: `pause` (which is also what the
	// absent-handler default returns) parks the run and persists the question.
	const reviewDecision = await ctx.resumeHandler(request)

	switch (reviewDecision.action) {
		case 'pause': {
			// NOTHING is said about the review's outcome here, because there is no outcome:
			// the question is still open. This used to emit `tool_review_completed
			// { decision: 'rejected' }` before parking, so a client that closes its approval
			// dialog and records "rejected" on `review.completed` — the only sane reading of
			// that event — told the user their tools had been DENIED while the batch sat on
			// disk waiting for them to approve it. Once the pause became durable it stopped
			// being merely wrong and became self-contradicting: hours later the human
			// approves, the run resumes, and a SECOND `tool_review_completed` goes out for
			// the same requestId saying `approved`. The pause is announced by `run_paused`.
			// The review completes exactly once — when it is actually decided.

			// D1: persist the question BEFORE the run is parked, so a process that dies
			// between the two leaves a checkpoint that still knows what it was waiting
			// for. The tool calls stay unanswered in the history on purpose — the pending
			// batch is what a resume acts on, and `pendingDecision` is what stops
			// `repairDanglingMessages` from rewriting it into "tool result missing" on the
			// way back in.
			const decision = buildPendingDecision(request)
			await ctx.checkpointMgr.attachPendingDecision(reviewCheckpoint.id, decision)

			// Park the run BEFORE the event goes out, so a listener that reads the run's
			// status on `run_paused` cannot observe it as still `running` — and park it ON
			// DISK, so a process killed before the generator returns leaves a run that can
			// still be answered rather than one stuck at `idle` holding a live decision.
			await ctx.runMgr.markSuspended({
				checkpointId: reviewCheckpoint.id,
				requestId: decision.requestId,
			})
			await ctx.emitEvent({
				type: 'run_paused',
				runId: ctx.runMgr.id,
				checkpointId: reviewCheckpoint.id,
				reason: reviewDecision.reason,
			})
			yield* ctx.drainPending()

			ctx.log.info('Run parked on a persisted tool-review decision', {
				runId: ctx.runMgr.id,
				requestId: decision.requestId,
				checkpointId: reviewCheckpoint.id,
				toolCalls: pendingSummaries.length,
			})
			return 'suspend'
		}

		case 'abort': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.runMgr.id,
				decision: 'rejected',
			})
			yield* ctx.drainPending()
			ctx.runMgr.setStopReason('cancelled')
			ctx.runMgr.markCancelled()
			return 'stop'
		}

		case 'approve_plan':
		case 'reject_plan': {
			ctx.log.warn('Unexpected plan decision during tool review', {
				action: reviewDecision.action,
			})
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.runMgr.id,
				decision: 'approved',
			})
			yield* ctx.drainPending()
			await executeCalls(reviewable.map((rc) => rc.call))
			return 'executed'
		}

		case 'approve_tools':
		case 'continue':
		case 'modify_tools':
		case 'reject_tools': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.runMgr.id,
				decision:
					reviewDecision.action === 'reject_tools'
						? 'rejected'
						: reviewDecision.action === 'modify_tools'
							? 'modified'
							: 'approved',
			})
			yield* ctx.drainPending()

			// One applier, shared with the resume dispatcher. If the live path and the
			// durable path each owned a copy of this, the durable one is the copy that
			// quietly loses the modified-input re-gate — and 171f339 is the commit that
			// shows how that ends.
			const applied = applyReviewOutcome({
				reviewable,
				outcome: reviewDecision,
				gate: ctx.verificationGate,
				tools: ctx.tools,
				log: ctx.log,
			})

			// Every reviewed call is answered, including the ones that will not run. Before
			// ses_017 the `reject_tools` path wrote no tool results at all and pushed only
			// the user note, leaving the assistant's tool-call block unanswered — a history
			// no provider accepts, shipped on the very next iteration.
			for (const denial of applied.denials) {
				ctx.runMgr.pushMessage(createToolMessage(denial.output, denial.toolCallId))
			}
			if (applied.systemNote) {
				ctx.runMgr.pushMessage(createUserMessage(applied.systemNote))
			}

			if (applied.approved.length === 0) {
				return 'rejected'
			}

			await executeCalls(applied.approved)
			return 'executed'
		}

		default: {
			const _exhaustive: never = reviewDecision
			throw new Error(
				`Unhandled tool review decision: ${(_exhaustive as { action: string }).action}`,
			)
		}
	}
}
