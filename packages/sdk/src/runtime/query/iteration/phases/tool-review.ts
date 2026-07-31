import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { RunEvent } from '../../../../types/run/index.js'
import type { VerificationGate } from '../../../../verification/index.js'
import type { ToolCallDenials } from '../../executor.js'
import { type IterationContext, awaitDecisionDurably } from './context.js'

interface VerificationAwareContext extends IterationContext {
	readonly verificationGate?: VerificationGate
}

export type ToolReviewDecision = 'executed' | 'rejected' | 'stop'

/**
 * What the review produced. The tool outcomes travel with the decision so
 * the loop can build a `StepResult` without re-deriving them from the
 * messages it just pushed.
 */
export interface ToolReviewOutcome {
	decision: ToolReviewDecision
	results: readonly import('../../executor.js').ToolCallOutcome[]
	/** Wall-clock spent executing tools in this review. */
	durationMs: number
}

/**
 * Run every tool call in `response` through the gate and (when the gate is
 * inconclusive) a human, then hand the whole batch — approved and refused
 * alike — to the executor.
 *
 * Two invariants this function is responsible for:
 *
 * 1. **Every `tool_use` is answered.** No branch may return without the
 *    executor having produced a `tool_result` for each call, because an
 *    unanswered `tool_use` makes the next provider request malformed. The
 *    refusal reason rides inside the `tool_result`, which is also what
 *    lets a rejection steer the model instead of just stopping it.
 * 2. **A gate denial is never overridable by an approval.** A human
 *    approving a batch approves the calls the gate left undecided — not
 *    the ones it refused. Gate denials are threaded into every downstream
 *    execution so no path can widen them.
 */
export async function* runToolReview(
	ctx: VerificationAwareContext,
	response: ChatCompletionResponse,
	iterationNum: number,
): AsyncGenerator<RunEvent, ToolReviewOutcome> {
	let executed: readonly import('../../executor.js').ToolCallOutcome[] = []
	let toolMs = 0

	const finish = (decision: ToolReviewDecision): ToolReviewOutcome => ({
		decision,
		results: executed,
		durationMs: toolMs,
	})

	const toolCalls = response.message.toolCalls
	if (!toolCalls || toolCalls.length === 0) {
		return finish('executed')
	}

	const toolCallSummaries = toolCalls.map((tc) => {
		let input: unknown
		try {
			input = JSON.parse(tc.function.arguments)
		} catch {
			input = tc.function.arguments
		}
		const tool = ctx.tools.get(tc.function.name)
		const isDestructive = tool?.isDestructive ? tool.isDestructive(input) : false

		return {
			id: tc.id,
			name: tc.function.name,
			input,
			isDestructive,
		}
	})

	/** Executes the batch, answering every call, and appends the results. */
	const settle = async (denials?: ToolCallDenials): Promise<void> => {
		const startedAt = Date.now()
		const batch = await ctx.toolExecutor.executeBatch(response, denials)
		toolMs += Date.now() - startedAt
		executed = batch.results
		for (const msg of batch.messages) {
			ctx.runMgr.pushMessage(msg)
		}
	}

	/** Every call denied for the same reason (human rejection, gate stop). */
	const denyAll = (reason: string): ToolCallDenials =>
		new Map(toolCalls.map((tc) => [tc.id, reason]))

	// Gate-denied ids survive the whole function: a later human approval
	// must not be able to release them.
	const gateDenied = new Map<string, string>()

	if (ctx.verificationGate) {
		const gate = ctx.verificationGate
		const gateResults = toolCallSummaries.map((tc) => ({
			toolCall: tc,
			gateResult: gate.evaluate({
				toolName: tc.name,
				toolInput: tc.input,
				toolDef: ctx.tools.get(tc.name),
			}),
		}))

		for (const gr of gateResults) {
			if (gr.gateResult.decision === 'deny') {
				gateDenied.set(gr.toolCall.id, `Blocked by the verification gate: ${gr.gateResult.reason}`)
			}
		}

		const allAllowed = gateResults.every((gr) => gr.gateResult.decision === 'allow')
		const allDenied = gateResults.every((gr) => gr.gateResult.decision === 'deny')

		if (allAllowed) {
			ctx.log.debug('Verification gate: all tool calls pre-approved', {
				tools: gateResults.map((gr) => gr.toolCall.name),
			})
			await settle()
			yield* ctx.drainPending()
			return finish('executed')
		}

		if (allDenied) {
			ctx.log.debug('Verification gate: all tool calls denied', {
				tools: gateResults.map((gr) => gr.toolCall.name),
			})
			await settle(gateDenied)
			yield* ctx.drainPending()
			return finish('rejected')
		}

		ctx.log.debug('Verification gate: mixed decisions, proceeding to review', {
			decisions: gateResults.map((gr) => ({
				tool: gr.toolCall.name,
				decision: gr.gateResult.decision,
			})),
		})
	}

	const reviewCheckpoint = await ctx.checkpointMgr.create(ctx.runMgr, iterationNum)

	await ctx.emitEvent({
		type: 'tool_review_requested',
		runId: ctx.runMgr.id,
		toolCalls: toolCallSummaries,
		iteration: iterationNum,
	})
	yield* ctx.drainPending()

	const reviewDecision = await awaitDecisionDurably(ctx, reviewCheckpoint, {
		type: 'tool_review',
		runId: ctx.runMgr.id,
		checkpointId: reviewCheckpoint.id,
		toolCalls: toolCallSummaries,
	})

	switch (reviewDecision.action) {
		case 'reject_tools': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.runMgr.id,
				decision: 'rejected',
			})
			yield* ctx.drainPending()

			const feedback = reviewDecision.feedback || 'The user rejected this tool call.'
			await settle(denyAll(feedback))
			yield* ctx.drainPending()
			return finish('rejected')
		}

		case 'modify_tools': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.runMgr.id,
				decision: 'modified',
			})
			yield* ctx.drainPending()

			// Gate denials are the floor; per-call human denials add to them.
			const denials = new Map(gateDenied)

			for (const mod of reviewDecision.modifications) {
				if (mod.action === 'modify' && mod.modifiedInput !== undefined) {
					const tc = toolCalls.find((t) => t.id === mod.toolCallId)
					// A modification cannot resurrect a gate-denied call.
					if (tc && !denials.has(tc.id)) {
						tc.function.arguments = JSON.stringify(mod.modifiedInput)
					}
				}
				if (mod.action === 'deny' && !denials.has(mod.toolCallId)) {
					denials.set(mod.toolCallId, 'The user denied this tool call.')
				}
			}

			const everythingDenied = denials.size === toolCalls.length
			await settle(denials)
			yield* ctx.drainPending()
			return finish(everythingDenied ? 'rejected' : 'executed')
		}

		case 'pause': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.runMgr.id,
				decision: 'rejected',
			})
			await ctx.emitEvent({
				type: 'run_paused',
				runId: ctx.runMgr.id,
				checkpointId: reviewCheckpoint.id,
				reason: reviewDecision.reason,
			})
			yield* ctx.drainPending()
			ctx.runMgr.setStopReason('paused')
			return finish('stop')
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
			return finish('stop')
		}

		case 'approve_tools':
		case 'continue': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.runMgr.id,
				decision: 'approved',
			})
			yield* ctx.drainPending()

			// `gateDenied` is non-empty only on the gate's mixed-decision
			// path. Passing it here is what stops a human "approve" from
			// executing calls the gate refused.
			await settle(gateDenied)
			yield* ctx.drainPending()
			return finish('executed')
		}

		case 'approve_plan':
		case 'reject_plan':
		// 'answer_question' belongs to an ask_user_question park, not a
		// tool review — like the misdirected plan decisions above, warn
		// and proceed with execution rather than stalling the run.
		case 'answer_question': {
			ctx.log.warn('Unexpected plan decision during tool review', {
				action: reviewDecision.action,
			})
			await settle(gateDenied)
			yield* ctx.drainPending()
			return finish('executed')
		}

		default: {
			const _exhaustive: never = reviewDecision
			throw new Error(
				`Unhandled tool review decision: ${(_exhaustive as { action: string }).action}`,
			)
		}
	}
}
