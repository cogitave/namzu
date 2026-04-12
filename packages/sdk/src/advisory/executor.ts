import { CHARS_PER_TOKEN } from '../constants/limits.js'
import { assembleSystemPrompt } from '../persona/assembler.js'
import type { AdvisorDefinition } from '../types/advisory/config.js'
import type { AdvisoryRequest, AdvisoryResult } from '../types/advisory/result.js'
import type { CostInfo, TokenUsage } from '../types/common/index.js'
import { type Message, createSystemMessage, createUserMessage } from '../types/message/index.js'
import type { LLMToolSchema } from '../types/tool/index.js'
import { type Logger, getRootLogger } from '../utils/logger.js'

export interface AdvisoryCallContext {
	readonly messages: Message[]
	readonly workingStateSummary?: string
	readonly toolCatalog?: LLMToolSchema[]
	readonly iteration: number
}

export interface AdvisoryExecutionResult {
	readonly result: AdvisoryResult
	readonly usage: TokenUsage
	readonly cost: CostInfo
	readonly durationMs: number
}

export class AdvisoryExecutor {
	private readonly logger: Logger

	constructor(logger?: Logger) {
		this.logger = (logger ?? getRootLogger()).child({ component: 'AdvisoryExecutor' })
	}

	async consult(
		advisor: AdvisorDefinition,
		request: AdvisoryRequest,
		callCtx: AdvisoryCallContext,
	): Promise<AdvisoryExecutionResult> {
		const startMs = Date.now()

		const systemPrompt = this.buildSystemPrompt(advisor)
		const contextMessages = this.buildContext(advisor, request, callCtx)

		const messages: Message[] = [
			createSystemMessage(systemPrompt),
			...contextMessages,
			createUserMessage(request.question),
		]

		this.logger.debug('advisory call starting', {
			advisorId: advisor.id,
			model: advisor.model,
			messageCount: messages.length,
			urgency: request.urgency,
		})

		const response = await advisor.provider.chat({
			model: advisor.model,
			messages,
			temperature: advisor.temperature,
			maxTokens: advisor.maxResponseTokens,
			toolChoice: 'none',
		})

		const durationMs = Date.now() - startMs

		const result = this.parseResult(response.message.content ?? '')

		const cost = this.computeCost(response.usage)

		this.logger.info('advisory call completed', {
			advisorId: advisor.id,
			model: advisor.model,
			durationMs,
			totalTokens: response.usage.totalTokens,
		})

		return {
			result,
			usage: response.usage,
			cost,
			durationMs,
		}
	}

	private buildSystemPrompt(advisor: AdvisorDefinition): string {
		if (advisor.systemPrompt) {
			return advisor.systemPrompt
		}

		if (advisor.persona) {
			return assembleSystemPrompt(advisor.persona)
		}

		return [
			`You are ${advisor.name}, an advisory agent.`,
			advisor.domains && advisor.domains.length > 0
				? `Your domains of expertise: ${advisor.domains.join(', ')}.`
				: undefined,
			'Provide concise, actionable advice. Focus on what the agent should do next.',
		]
			.filter(Boolean)
			.join('\n\n')
	}

	private buildContext(
		advisor: AdvisorDefinition,
		request: AdvisoryRequest,
		callCtx: AdvisoryCallContext,
	): Message[] {
		if (request.includeContext === false) {
			return []
		}

		const contextParts: string[] = []

		if (callCtx.workingStateSummary) {
			contextParts.push(`## Working State\n${callCtx.workingStateSummary}`)
		}

		if (callCtx.toolCatalog && callCtx.toolCatalog.length > 0) {
			const toolNames = callCtx.toolCatalog.map((t) => t.function.name)
			contextParts.push(`## Available Tools\n${toolNames.join(', ')}`)
		}

		const messagesToInclude = this.truncateMessages(callCtx.messages, advisor.maxContextTokens)

		if (messagesToInclude.length > 0) {
			const conversationSummary = messagesToInclude
				.map((m) => `[${m.role}]: ${m.content ?? '(tool calls)'}`)
				.join('\n')
			contextParts.push(`## Conversation Context\n${conversationSummary}`)
		}

		if (contextParts.length === 0) {
			return []
		}

		return [createUserMessage(contextParts.join('\n\n'))]
	}

	private truncateMessages(messages: Message[], maxTokens: number | undefined): Message[] {
		if (!maxTokens) {
			return messages
		}

		const charBudget = maxTokens * CHARS_PER_TOKEN
		let totalChars = 0
		const result: Message[] = []

		// Walk from most recent to oldest, accumulate until budget exhausted
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as Message
			const msgChars = (msg.content ?? '').length
			if (totalChars + msgChars > charBudget) break
			totalChars += msgChars
			result.unshift(msg)
		}

		return result
	}

	/**
	 * Parses the raw LLM response into an AdvisoryResult.
	 *
	 * Phase 1: text-only extraction. Structured parsing comes later.
	 */
	private parseResult(rawContent: string): AdvisoryResult {
		return {
			advice: rawContent,
		}
	}

	/**
	 * Computes cost from token usage.
	 *
	 * Returns zero-value cost since pricing is provider-specific.
	 * Callers with pricing data can recompute via calculateCost().
	 */
	private computeCost(_usage: TokenUsage): CostInfo {
		return {
			inputCostPer1M: 0,
			outputCostPer1M: 0,
			totalCost: 0,
			cacheDiscount: 0,
		}
	}
}
