import type { ToolCallSummary } from '../../../../types/hitl/index.js'
import { createToolMessage, createUserMessage } from '../../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { RunEvent } from '../../../../types/run/index.js'
import type { GateEvaluationResult } from '../../../../types/verification/index.js'
import { toErrorMessage } from '../../../../utils/error.js'
import { type VerificationGate, gateDenialOutput } from '../../../../verification/index.js'
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

type ProviderToolCall = NonNullable<ChatCompletionResponse['message']['toolCalls']>[number]

/**
 * A call that survived the deny plane.
 *
 * The human is shown these and only these; the executor is driven from these and
 * only these. A gate-denied call never becomes one, so no human decision — not
 * `approve_tools`, not a `modify` that names its id — has anything to reach for.
 * That is the whole point of the type: "the batch the human approved" and "the
 * batch the model asked for" are no longer the same value.
 */
interface ReviewableCall {
	readonly call: ProviderToolCall
	readonly summary: ToolCallSummary
	readonly decision: 'allow' | 'review'
}

/**
 * Gate evaluation that denies when it breaks (conventions/fail-closed-gates).
 *
 * A rule is a predicate over an input shape it did not choose — `deny_dangerous_patterns`
 * stringifies it, `custom_pattern` regexes it — and the gate exists to say no, so
 * "this check crashed" must not read as "this check approved". It must not take
 * the run down either: the caller answers the model with a denial result instead.
 *
 * This phase's gate decides WHAT A HUMAN IS ASKED: it drops denied calls before a
 * reviewer sees them, and sorts the rest into allow (run without asking) vs review.
 * It is not what makes a denial safe. The input it judges is still a *proposal* —
 * `pre_tool_use` plugin hooks can rewrite it afterwards — so the authoritative
 * check runs at the dispatch point, in `ToolExecutor.denyFinalInput`, against the
 * input that can no longer change. Two checks, two jobs: this one shapes the human
 * decision, that one is the non-bypassable backstop.
 */
function evaluateGate(
	gate: VerificationGate,
	ctx: VerificationAwareContext,
	toolName: string,
	toolInput: unknown,
): GateEvaluationResult {
	try {
		return gate.evaluate({
			toolName,
			toolInput,
			toolDef: ctx.tools.get(toolName),
		})
	} catch (err) {
		ctx.log.error('Verification gate threw while evaluating a tool call — denying', {
			tool: toolName,
			error: toErrorMessage(err),
		})
		return {
			decision: 'deny',
			matchedRule: null,
			reason: 'Verification gate error',
		}
	}
}

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
			result: evaluateGate(gate, ctx, rc.summary.name, rc.summary.input),
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
	const pendingSummaries = reviewable.map((rc) => rc.summary)

	await ctx.emitEvent({
		type: 'tool_review_requested',
		runId: ctx.runMgr.id,
		toolCalls: pendingSummaries,
		iteration: iterationNum,
	})
	yield* ctx.drainPending()

	const reviewDecision = await ctx.resumeHandler({
		type: 'tool_review',
		runId: ctx.runMgr.id,
		checkpointId: reviewCheckpoint.id,
		toolCalls: pendingSummaries,
	})

	switch (reviewDecision.action) {
		case 'reject_tools': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.runMgr.id,
				decision: 'rejected',
			})
			yield* ctx.drainPending()

			const feedback = reviewDecision.feedback || 'User rejected the tool calls'
			ctx.runMgr.pushMessage(createUserMessage(`[SYSTEM] Tool calls rejected: ${feedback}`))
			return 'rejected'
		}

		case 'modify_tools': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.runMgr.id,
				decision: 'modified',
			})
			yield* ctx.drainPending()

			const modifications = new Map(
				reviewDecision.modifications.map((mod) => [mod.toolCallId, mod]),
			)
			const approved: ProviderToolCall[] = []

			for (const rc of reviewable) {
				const mod = modifications.get(rc.call.id)

				if (mod?.action === 'deny') {
					ctx.runMgr.pushMessage(
						createToolMessage(`Error: Tool call "${rc.summary.name}" denied by user`, rc.call.id),
					)
					continue
				}

				if (mod?.action === 'modify' && mod.modifiedInput !== undefined) {
					// The gate saw the input the model wrote, not the one about to run.
					// A modification is a new call and is authorized as one — a benign
					// call the human approved must not become a denied operation by way
					// of a typo, a compromised client, or a malicious modify payload.
					//
					// `ToolExecutor.denyFinalInput` would catch this one too, and that is
					// the check safety rests on. This one is kept because it changes the
					// DECISION, not just the outcome: a denied modification is dropped
					// from the approved set here, so if nothing survives, the phase ends
					// as 'rejected' with the model told why — rather than dispatching a
					// batch that is guaranteed to come back denied. The executor's check
					// stays the backstop; this one keeps the review phase honest about
					// what it approved.
					if (ctx.verificationGate) {
						const verdict = evaluateGate(
							ctx.verificationGate,
							ctx,
							rc.summary.name,
							mod.modifiedInput,
						)
						if (verdict.decision === 'deny') {
							ctx.log.warn(
								'Verification gate: modified tool call denied — modification rejected, not executing',
								{ tool: rc.summary.name, reason: verdict.reason },
							)
							ctx.runMgr.pushMessage(
								createToolMessage(gateDenialOutput(rc.summary.name, verdict.reason), rc.call.id),
							)
							continue
						}
					}
					rc.call.function.arguments = JSON.stringify(mod.modifiedInput)
				}

				approved.push(rc.call)
			}

			if (approved.length === 0) {
				ctx.runMgr.pushMessage(createUserMessage('[SYSTEM] All tool calls were denied by user'))
				return 'rejected'
			}

			await executeCalls(approved)
			return 'executed'
		}

		case 'pause': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.runMgr.id,
				decision: 'rejected',
			})
			// Park the run BEFORE the event goes out, so a listener that reads the
			// run's status on `run_paused` cannot observe it as still `running`.
			// The tool calls stay unanswered in the history on purpose: the pending
			// batch is what a resume has to act on, and `reviewCheckpoint` is where
			// it was saved.
			ctx.runMgr.markSuspended()
			await ctx.emitEvent({
				type: 'run_paused',
				runId: ctx.runMgr.id,
				checkpointId: reviewCheckpoint.id,
				reason: reviewDecision.reason,
			})
			yield* ctx.drainPending()
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

		case 'approve_tools':
		case 'continue': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.runMgr.id,
				decision: 'approved',
			})
			yield* ctx.drainPending()

			await executeCalls(reviewable.map((rc) => rc.call))
			return 'executed'
		}

		case 'approve_plan':
		case 'reject_plan': {
			ctx.log.warn('Unexpected plan decision during tool review', {
				action: reviewDecision.action,
			})
			await executeCalls(reviewable.map((rc) => rc.call))
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
