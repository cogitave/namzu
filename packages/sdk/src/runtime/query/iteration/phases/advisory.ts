import { serializeState } from '../../../../compaction/serializer.js'
import type { AdvisoryRequest } from '../../../../types/advisory/index.js'
import type { TriggerEvaluationState } from '../../../../types/advisory/index.js'
import { createUserMessage } from '../../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import { toErrorMessage } from '../../../../utils/error.js'
import type { IterationContext } from './context.js'

function countToolCalls(ctx: IterationContext): number {
	let count = 0
	for (const msg of ctx.sessionMgr.messages) {
		if (msg.role === 'assistant' && msg.toolCalls) {
			count += msg.toolCalls.length
		}
	}
	return count
}

function estimateContextWindowPercent(ctx: IterationContext): number {
	const budget = ctx.sessionConfig.tokenBudget
	if (budget <= 0) return 0
	return (ctx.sessionMgr.tokenUsage.totalTokens / budget) * 100
}

function computeCostBudgetPercent(ctx: IterationContext): number | undefined {
	const limit = ctx.sessionConfig.costLimitUsd
	if (limit === undefined || limit <= 0) return undefined
	return (ctx.sessionMgr.costInfo.totalCost / limit) * 100
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
): Promise<void> {
	const advisoryCtx = ctx.advisoryCtx
	if (!advisoryCtx) return

	const budgetCheck = advisoryCtx.checkBudget()
	if (!budgetCheck.allowed) {
		ctx.log.debug('Advisory budget exhausted, skipping advisory phase', {
			runId: ctx.sessionMgr.id,
			reason: budgetCheck.reason,
		})
		return
	}

	const evalState: TriggerEvaluationState = {
		iteration: iterationNum,
		totalToolCalls: countToolCalls(ctx),
		totalTokens: ctx.sessionMgr.tokenUsage.totalTokens,
		contextWindowPercent: estimateContextWindowPercent(ctx),
		totalCostUsd: ctx.sessionMgr.costInfo.totalCost,
		costBudgetPercent: computeCostBudgetPercent(ctx),
		lastError: extractLastErrorFromMessages(ctx),
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
			runId: ctx.sessionMgr.id,
			triggerId: trigger.id,
			advisorId: trigger.advisorId,
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
			messages: ctx.sessionMgr.messages,
			workingStateSummary,
			toolCatalog: ctx.tools.toLLMTools(ctx.allowedTools),
			iteration: iterationNum,
		})

		advisoryCtx.evaluator.recordFiring(trigger.id, iterationNum)

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

		ctx.sessionMgr.pushMessage(createUserMessage(sections.join('\n')))

		ctx.log.info('Advisory phase completed', {
			runId: ctx.sessionMgr.id,
			iteration: iterationNum,
			triggerId: trigger.id,
			advisorId: advisor.id,
			durationMs: executionResult.durationMs,
			totalAdvisoryCalls: advisoryCtx.callHistory.length,
		})
	} catch (err) {
		ctx.log.warn('Advisory phase failed', {
			runId: ctx.sessionMgr.id,
			iteration: iterationNum,
			triggerId: trigger.id,
			advisorId: advisor.id,
			error: toErrorMessage(err),
		})
	}
}

function extractLastErrorFromMessages(ctx: IterationContext): string | undefined {
	const messages = ctx.sessionMgr.messages
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg?.role === 'tool' && msg.content?.startsWith('Error:')) {
			return msg.content
		}
	}
	return undefined
}
