import type { AdvisoryTurnContext } from '../../../../advisory/executor.js'
import { serializeState } from '../../../../compaction/serializer.js'
import { NAMZU } from '../../../../constants/telemetry/index.js'
import type { AdvisoryRequest, TriggerEvaluationState } from '../../../../types/advisory/index.js'
import { toolResultToText } from '../../../../types/message/content.js'
import { createRuntimeContextMessage } from '../../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import { toErrorMessage } from '../../../../utils/error.js'
import { activeContextWindow, measureContext } from './compaction.js'
import type { IterationContext } from './context.js'

function countToolCalls(ctx: IterationContext): number {
	let count = 0
	for (const msg of ctx.recorder.messages) {
		if (msg.role === 'assistant' && msg.toolCalls) {
			count += msg.toolCalls.length
		}
	}
	return count
}

function estimateContextWindowPercent(ctx: IterationContext): number {
	const window = activeContextWindow(ctx)
	return (measureContext(ctx).tokens / window.tokens) * 100
}

function computeCostBudgetPercent(ctx: IterationContext): number | undefined {
	const limit = ctx.turnConfig.costLimitUsd
	if (limit === undefined || limit <= 0) return undefined
	return (ctx.recorder.costInfo.totalCost / limit) * 100
}

function extractLastToolCategory(
	ctx: IterationContext,
	response: ChatCompletionResponse,
): string | undefined {
	const toolCalls = response.message.toolCalls
	if (!toolCalls || toolCalls.length === 0) return undefined

	const lastToolCall = toolCalls[toolCalls.length - 1]
	if (!lastToolCall) return undefined

	const tool = ctx.tools.get(lastToolCall.function.name)
	return tool?.category
}

export async function runAdvisoryPhase(
	ctx: IterationContext,
	iterationNum: number,
	response: ChatCompletionResponse,
	turn?: AdvisoryTurnContext,
): Promise<void> {
	const advisoryCtx = ctx.advisoryCtx
	if (!advisoryCtx) return

	const budgetCheck = advisoryCtx.checkBudget()
	if (!budgetCheck.allowed) {
		ctx.log.debug('Advisory budget exhausted, skipping advisory phase', {
			[NAMZU.TURN_ID]: ctx.recorder.turnId,
			'namzu.runtime.reason': budgetCheck.reason,
		})
		return
	}

	const evalState: TriggerEvaluationState = {
		iteration: iterationNum,
		totalToolCalls: countToolCalls(ctx),
		totalTokens: ctx.recorder.tokenUsage.totalTokens,
		contextWindowPercent: estimateContextWindowPercent(ctx),
		totalCostUsd: ctx.recorder.costInfo.totalCost,
		costBudgetPercent: computeCostBudgetPercent(ctx),
		lastError: extractCurrentToolErrors(ctx, response),
		lastToolCategory: extractLastToolCategory(ctx, response),
		advisoryCallCount: advisoryCtx.callHistory.length,
	}

	const firedTriggers = advisoryCtx.evaluator.evaluate(evalState)
	if (firedTriggers.length === 0) return

	const trigger = firedTriggers[0]
	if (!trigger) return

	const advisor = advisoryCtx.registry.resolve(trigger.advisorId)
	if (!advisor) {
		ctx.log.warn('Advisory trigger fired but advisor not found', {
			[NAMZU.TURN_ID]: ctx.recorder.turnId,
			'namzu.runtime.trigger_id': trigger.id,
			'namzu.advisory.id': trigger.advisorId,
		})
		return
	}

	const question =
		trigger.questionTemplate ??
		`Iteration ${iterationNum}: Review the current progress and provide guidance.`

	const request: AdvisoryRequest = {
		advisorId: advisor.id,
		question,
		includeContext: true,
	}

	const workingStateSummary = ctx.workingStateManager
		? serializeState(ctx.workingStateManager.getState())
		: undefined

	try {
		const executionResult = await advisoryCtx.executor.consult(advisor, request, {
			messages: ctx.recorder.messages,
			...(turn ? { turn } : {}),
			workingStateSummary,
			toolCatalog: ctx.tools.toLLMTools(ctx.allowedTools),
			iteration: iterationNum,
		})

		advisoryCtx.evaluator.recordFiring(trigger.id, iterationNum)

		// An advisory call is a real model call on the turn's dime. It was
		// recorded into `callHistory` for reporting but never reached
		// `recorder.tokenUsage`, so the guard could not see it: a turn with
		// `tokenBudget: 200_000` and an `on_error` trigger could send well
		// past 200k and never trip `token_budget`. The usage is already in
		// hand — this just tells the accountant about it.
		// Priced against the ADVISOR's own driver and model, not the turn's. An
		// advisor carries its own `provider`, so attributing its tokens to
		// whoever is serving the main loop would price one vendor's work at
		// another's card — which is the class of quiet wrongness the whole
		// catalogue exists to remove, and it would be invisible here.
		ctx.recorder.accumulateUsage(executionResult.usage, {
			providerId: advisor.provider.id,
			model: advisor.model,
		})

		advisoryCtx.recordCall({
			advisorId: advisor.id,
			triggerId: trigger.id,
			request,
			result: executionResult.result,
			usage: executionResult.usage,
			cost: executionResult.cost,
			durationMs: executionResult.durationMs,
			iteration: iterationNum,
			timestamp: Date.now(),
		})

		if (
			executionResult.result.decisions &&
			executionResult.result.decisions.length > 0 &&
			ctx.workingStateManager
		) {
			for (const decision of executionResult.result.decisions) {
				ctx.workingStateManager.addDecision(decision)
			}
		}

		const sections: string[] = [
			`<advisory-result advisor="${advisor.name}" trigger="${trigger.id}">`,
		]
		sections.push(executionResult.result.advice)

		if (executionResult.result.warnings && executionResult.result.warnings.length > 0) {
			sections.push(
				`\nWarnings:\n${executionResult.result.warnings.map((w) => `- ${w}`).join('\n')}`,
			)
		}

		if (executionResult.result.decisions && executionResult.result.decisions.length > 0) {
			sections.push(
				`\nDecisions:\n${executionResult.result.decisions.map((d) => `- ${d}`).join('\n')}`,
			)
		}

		sections.push('</advisory-result>')

		ctx.recorder.pushMessage(createRuntimeContextMessage(sections.join('\n'), 'advisory'))

		ctx.log.info('Advisory phase completed', {
			[NAMZU.TURN_ID]: ctx.recorder.turnId,
			[NAMZU.ITERATION]: iterationNum,
			'namzu.runtime.trigger_id': trigger.id,
			'namzu.advisory.id': advisor.id,
			'namzu.duration_ms': executionResult.durationMs,
			'namzu.runtime.total_advisory_calls': advisoryCtx.callHistory.length,
		})
	} catch (err) {
		ctx.log.warn('Advisory phase failed', {
			[NAMZU.TURN_ID]: ctx.recorder.turnId,
			[NAMZU.ITERATION]: iterationNum,
			'namzu.runtime.trigger_id': trigger.id,
			'namzu.advisory.id': advisor.id,
			'exception.message': toErrorMessage(err),
		})
	}
}

function extractCurrentToolErrors(
	ctx: IterationContext,
	response: ChatCompletionResponse,
): string | undefined {
	const calls = new Map(response.message.toolCalls?.map((call) => [call.id, call.function.name]))
	if (calls.size === 0) return undefined
	const messages = ctx.recorder.messages
	const errors: string[] = []
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		// The current assistant turn starts this batch. Never resurrect an old
		// failure, even if a provider reused a call ID in another iteration.
		if (msg?.role === 'assistant') break
		if (msg?.role === 'tool' && msg.isError === true && calls.has(msg.toolCallId)) {
			errors.push(
				toolResultToText(msg.content).trim() ||
					`Tool ${calls.get(msg.toolCallId)} reported an error.`,
			)
		}
	}
	// A successful sibling does not erase failed results in this same batch.
	return errors.length > 0 ? errors.reverse().join('\n') : undefined
}
