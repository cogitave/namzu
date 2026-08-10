import { CHARS_PER_TOKEN, ZERO_COST } from '../constants/limits.js'
import { assembleSystemPrompt } from '../persona/assembler.js'
import { resolveModelPricing } from '../pricing/index.js'
import { collect } from '../provider/collect.js'

import type { AdvisorDefinition, AdvisoryBudget } from '../types/advisory/config.js'
import type { AdvisoryRequest, AdvisoryResult } from '../types/advisory/result.js'
import type { CostInfo, TokenUsage } from '../types/common/index.js'
import { type Message, createSystemMessage, createUserMessage } from '../types/message/index.js'
import type { LLMToolSchema } from '../types/tool/index.js'
import { accumulateUnpricedCost, calculateCost } from '../utils/cost.js'
import { type Logger, getRootLogger } from '../utils/logger.js'
import { ADVISORY_RESPONSE_CONTRACT, parseAdvisoryResponse } from './parse.js'

/**
 * What the advisor is told about how urgent the caller said this is.
 *
 * `'normal'` says nothing on purpose. A sentence asserting the ordinary case
 * is prompt weight that changes no answer, and stating it on every call
 * would make the two that matter harder to notice.
 */
const URGENCY_DIRECTION: Record<'low' | 'normal' | 'high', string | undefined> = {
	high: 'This request is marked URGENT. Lead with the single most important action and keep the reasoning to what is needed to justify it.',
	normal: undefined,
	low: 'This request is marked low urgency. There is room to note secondary considerations and alternatives worth weighing.',
}

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
	private readonly budget: AdvisoryBudget | undefined

	constructor(logger?: Logger, budget?: AdvisoryBudget) {
		this.logger = (logger ?? getRootLogger()).child({ component: 'AdvisoryExecutor' })
		this.budget = budget
	}

	/**
	 * The response ceiling for one call: the tighter of what the advisor
	 * asks for and what the budget allows. An advisor that names no ceiling
	 * still gets the budget's, which is the whole point of a per-call cap.
	 */
	private responseTokenCeiling(advisor: AdvisorDefinition): number | undefined {
		const cap = this.budget?.maxTokensPerCall
		if (cap === undefined) return advisor.maxResponseTokens
		if (advisor.maxResponseTokens === undefined) return cap
		return Math.min(advisor.maxResponseTokens, cap)
	}

	async consult(
		advisor: AdvisorDefinition,
		request: AdvisoryRequest,
		callCtx: AdvisoryCallContext,
	): Promise<AdvisoryExecutionResult> {
		const startMs = Date.now()

		const systemPrompt = this.buildSystemPrompt(advisor, request.urgency)
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

		const response = await collect(
			advisor.provider.chatStream({
				model: advisor.model,
				messages,
				temperature: advisor.temperature,
				maxTokens: this.responseTokenCeiling(advisor),
				toolChoice: 'none',
			}),
		)

		const durationMs = Date.now() - startMs

		const result = parseAdvisoryResponse(response.message.content ?? '')

		const cost = this.computeCost(advisor, response.usage)

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

	private buildSystemPrompt(
		advisor: AdvisorDefinition,
		urgency?: AdvisoryRequest['urgency'],
	): string {
		// The contract is appended to every branch, not folded into the
		// default: an advisor with its own prompt or a persona is still read
		// back by the same parser, and used to be the one never told so.
		const parts = [this.describeAdvisor(advisor), ADVISORY_RESPONSE_CONTRACT]

		// The caller is invited to say how urgent this is, and the value used
		// to reach exactly one debug log line — `urgency: 'high'` and
		// `urgency: 'low'` produced byte-identical requests. Telling the
		// ADVISOR is the honest minimum: it is the party that can act on the
		// answer, and it costs one sentence rather than a routing policy this
		// kernel has no business inventing.
		const direction = URGENCY_DIRECTION[urgency ?? 'normal']
		if (direction) parts.push(direction)

		return parts.join('\n\n')
	}

	private describeAdvisor(advisor: AdvisorDefinition): string {
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
			const toolLines = callCtx.toolCatalog.map((tool) => {
				const description = tool.function.description?.trim()
				return description ? `- ${tool.function.name}: ${description}` : `- ${tool.function.name}`
			})
			contextParts.push(
				[
					'## Runtime Tool Summary',
					'These tools are available to the executor. Their executable schemas remain owned by the runtime tool catalogue; use this as advisory context only.',
					toolLines.join('\n'),
				].join('\n'),
			)
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
	 * Cost for one call, from the advisor's own pricing, then the catalogue.
	 *
	 * When neither has a rate this reports the tokens as UNPRICED rather than
	 * as a cost of zero. The previous version returned a zero rate card and a
	 * zero total, defended on the grounds that a cost CAP over unpriced
	 * advisors is refused at construction so nothing enforces against it — true
	 * of the cap, and beside the point for the reader. `AdvisoryResult.cost` is
	 * reported to the host, and `$0.00` for a call that cost real money is the
	 * exact defect this change exists to remove; it does not become acceptable
	 * because the number happens to be unenforced.
	 */
	private computeCost(advisor: AdvisorDefinition, usage: TokenUsage): CostInfo {
		const pricing = advisor.pricing ?? resolveModelPricing(advisor.provider.id, advisor.model)
		if (!pricing) {
			return accumulateUnpricedCost(ZERO_COST, usage)
		}
		return calculateCost(usage, pricing)
	}
}
