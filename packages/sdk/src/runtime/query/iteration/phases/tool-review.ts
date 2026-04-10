import { createUserMessage } from '../../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { RunEvent } from '../../../../types/run/index.js'
import type { VerificationGate } from '../../../../verification/index.js'
import type { IterationContext } from './context.js'

interface VerificationAwareContext extends IterationContext {
	readonly verificationGate?: VerificationGate
}

export type ToolReviewOutcome = 'executed' | 'rejected' | 'stop'

export async function* runToolReview(
	ctx: VerificationAwareContext,
	response: ChatCompletionResponse,
	iterationNum: number,
): AsyncGenerator<RunEvent, ToolReviewOutcome> {
	const toolCalls = response.message.toolCalls
	if (!toolCalls || toolCalls.length === 0) {
		return 'executed'
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

		const allAllowed = gateResults.every((gr) => gr.gateResult.decision === 'allow')
		const allDenied = gateResults.every((gr) => gr.gateResult.decision === 'deny')

		if (allAllowed) {
			ctx.log.debug('Verification gate: all tool calls pre-approved', {
				tools: gateResults.map((gr) => gr.toolCall.name),
			})
			const batch = await ctx.toolExecutor.executeBatch(response)
			for (const msg of batch.messages) {
				ctx.sessionMgr.pushMessage(msg)
			}
			return 'executed'
		}

		if (allDenied) {
			const reasons = gateResults
				.map((gr) => `${gr.toolCall.name}: ${gr.gateResult.reason}`)
				.join('; ')
			ctx.log.debug('Verification gate: all tool calls denied', {
				tools: gateResults.map((gr) => gr.toolCall.name),
			})
			ctx.sessionMgr.pushMessage(
				createUserMessage(`[SYSTEM] Tool calls blocked by verification gate: ${reasons}`),
			)
			return 'rejected'
		}

		ctx.log.debug('Verification gate: mixed decisions, proceeding to review', {
			decisions: gateResults.map((gr) => ({
				tool: gr.toolCall.name,
				decision: gr.gateResult.decision,
			})),
		})
	}

	const reviewCheckpoint = await ctx.checkpointMgr.create(ctx.sessionMgr, iterationNum)

	await ctx.emitEvent({
		type: 'tool_review_requested',
		runId: ctx.sessionMgr.id,
		toolCalls: toolCallSummaries,
		iteration: iterationNum,
	})
	yield* ctx.drainPending()

	const reviewDecision = await ctx.resumeHandler({
		type: 'tool_review',
		runId: ctx.sessionMgr.id,
		checkpointId: reviewCheckpoint.id,
		toolCalls: toolCallSummaries,
	})

	switch (reviewDecision.action) {
		case 'reject_tools': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.sessionMgr.id,
				decision: 'rejected',
			})
			yield* ctx.drainPending()

			const feedback = reviewDecision.feedback || 'User rejected the tool calls'
			ctx.sessionMgr.pushMessage(createUserMessage(`[SYSTEM] Tool calls rejected: ${feedback}`))
			return 'rejected'
		}

		case 'modify_tools': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.sessionMgr.id,
				decision: 'modified',
			})
			yield* ctx.drainPending()

			for (const mod of reviewDecision.modifications) {
				if (mod.action === 'modify' && mod.modifiedInput !== undefined) {
					const tc = toolCalls.find((t) => t.id === mod.toolCallId)
					if (tc) {
						tc.function.arguments = JSON.stringify(mod.modifiedInput)
					}
				}
			}

			const deniedIds = new Set(
				reviewDecision.modifications.filter((m) => m.action === 'deny').map((m) => m.toolCallId),
			)
			const filteredToolCalls = toolCalls.filter((tc) => !deniedIds.has(tc.id))

			if (filteredToolCalls.length === 0) {
				ctx.sessionMgr.pushMessage(createUserMessage('[SYSTEM] All tool calls were denied by user'))
				return 'rejected'
			}

			const batch = await ctx.toolExecutor.executeBatch({
				...response,
				message: { ...response.message, toolCalls: filteredToolCalls },
			})
			for (const msg of batch.messages) {
				ctx.sessionMgr.pushMessage(msg)
			}
			return 'executed'
		}

		case 'pause': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.sessionMgr.id,
				decision: 'rejected',
			})
			await ctx.emitEvent({
				type: 'run_paused',
				runId: ctx.sessionMgr.id,
				checkpointId: reviewCheckpoint.id,
				reason: reviewDecision.reason,
			})
			yield* ctx.drainPending()
			ctx.sessionMgr.setStopReason('paused')
			return 'stop'
		}

		case 'abort': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.sessionMgr.id,
				decision: 'rejected',
			})
			yield* ctx.drainPending()
			ctx.sessionMgr.setStopReason('cancelled')
			ctx.sessionMgr.markCancelled()
			return 'stop'
		}

		case 'approve_tools':
		case 'continue': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				runId: ctx.sessionMgr.id,
				decision: 'approved',
			})
			yield* ctx.drainPending()

			const batch = await ctx.toolExecutor.executeBatch(response)
			for (const msg of batch.messages) {
				ctx.sessionMgr.pushMessage(msg)
			}
			return 'executed'
		}

		case 'approve_plan':
		case 'reject_plan': {
			ctx.log.warn('Unexpected plan decision during tool review', {
				action: reviewDecision.action,
			})
			const batch = await ctx.toolExecutor.executeBatch(response)
			for (const msg of batch.messages) {
				ctx.sessionMgr.pushMessage(msg)
			}
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
