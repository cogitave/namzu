import { z } from 'zod'
import type { AdvisoryContext } from '../../advisory/context.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

export interface AdvisoryToolsOptions {
	readonly advisoryCtx: AdvisoryContext
}

export function buildAdvisoryTools(opts: AdvisoryToolsOptions): ToolDefinition[] {
	const { advisoryCtx } = opts

	const listAdvisors = defineTool({
		name: 'list_advisors',
		description:
			'List all available advisory agents with their domains of expertise and current budget status. Use this to discover which advisors are available before consulting one.',
		inputSchema: z.object({}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute() {
			const advisors = advisoryCtx.registry.listAll()
			const budget = advisoryCtx.getBudgetStatus()

			const lines = advisors.map((a) => {
				const domains = a.domains && a.domains.length > 0 ? a.domains.join(', ') : 'general'
				return `- ${a.id}: ${a.name} [domains: ${domains}]`
			})

			const budgetLine =
				budget.total !== undefined
					? `Budget: ${budget.used}/${budget.total} calls used (${budget.remaining} remaining)`
					: `Budget: ${budget.used} calls used (unlimited)`

			return {
				success: true,
				output:
					advisors.length === 0
						? 'No advisors configured.'
						: `${advisors.length} advisor(s) available:\n${lines.join('\n')}\n\n${budgetLine}`,
				data: {
					advisors: advisors.map((a) => ({
						id: a.id,
						name: a.name,
						domains: a.domains ?? [],
						model: a.model,
					})),
					budget,
				},
			}
		},
	})

	const consultAdvisor = defineTool({
		name: 'consult_advisor',
		description:
			'Consult an advisory agent for guidance. Resolves the advisor by explicit ID, domain match, or falls back to the default advisor. Checks budget before calling. Returns structured advice with optional warnings and decisions.',
		inputSchema: z.object({
			advisor_id: z.string().optional().describe('Explicit advisor ID to consult'),
			question: z.string().describe('The question or situation to get advice on'),
			domain: z
				.string()
				.optional()
				.describe('Domain to match an advisor (e.g. "security", "architecture")'),
			urgency: z
				.enum(['low', 'normal', 'high'])
				.optional()
				.describe('How urgent the advisory need is'),
			include_context: z
				.boolean()
				.optional()
				.describe('Whether to include conversation context in the advisory call'),
		}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute({ advisor_id, question, domain, urgency, include_context }) {
			const budgetCheck = advisoryCtx.checkBudget()
			if (!budgetCheck.allowed) {
				return {
					success: false,
					output: budgetCheck.reason ?? 'Advisory budget exhausted',
					error: budgetCheck.reason,
				}
			}

			const advisor = advisoryCtx.registry.resolve(advisor_id, domain)
			if (!advisor) {
				return {
					success: false,
					output: advisor_id
						? `Advisor not found: ${advisor_id}`
						: domain
							? `No advisor found for domain: ${domain}`
							: 'No advisors configured',
					error: 'Advisor resolution failed',
				}
			}

			const executionResult = await advisoryCtx.executor.consult(
				advisor,
				{ advisorId: advisor.id, question, domain, urgency, includeContext: include_context },
				{ messages: [], iteration: 0 },
			)

			advisoryCtx.recordCall({
				advisorId: advisor.id,
				request: {
					advisorId: advisor.id,
					question,
					domain,
					urgency,
					includeContext: include_context,
				},
				result: executionResult.result,
				usage: executionResult.usage,
				cost: executionResult.cost,
				durationMs: executionResult.durationMs,
				iteration: 0,
				timestamp: Date.now(),
			})

			const sections: string[] = []

			sections.push(`## Advice from ${advisor.name}\n\n${executionResult.result.advice}`)

			if (executionResult.result.warnings && executionResult.result.warnings.length > 0) {
				sections.push(
					`## Warnings\n\n${executionResult.result.warnings.map((w) => `- ${w}`).join('\n')}`,
				)
			}

			if (executionResult.result.decisions && executionResult.result.decisions.length > 0) {
				sections.push(
					`## Decisions\n\n${executionResult.result.decisions.map((d) => `- ${d}`).join('\n')}`,
				)
			}

			return {
				success: true,
				output: sections.join('\n\n'),
				data: {
					advisorId: advisor.id,
					result: executionResult.result,
					usage: executionResult.usage,
					durationMs: executionResult.durationMs,
				},
			}
		},
	})

	return [listAdvisors, consultAdvisor]
}
