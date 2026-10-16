import { defineTool } from '@namzu/sdk'
import { z } from 'zod'
import { DecisionError, type DecisionModel } from './contract.js'

export const DECIDE_TOOL_NAME = 'decide' as const

const inputSchema = z.object({
	kind: z
		.enum(['yesno', 'choice', 'score'])
		.describe(
			'yesno = probability a statement is true; choice = pick one of `options`; score = pick one of ordered `levels`.',
		),
	context: z
		.string()
		.describe('The situation to judge: the state, the evidence, whatever the decision turns on.'),
	question: z
		.string()
		.describe(
			'What to decide, phrased for the chosen kind (a yes/no claim, a pick instruction, a scoring rubric).',
		),
	options: z
		.array(z.string())
		.optional()
		.describe('kind="choice" only: the options to pick exactly one of (2 or more).'),
	levels: z
		.array(z.string())
		.optional()
		.describe('kind="score" only: the ordered levels, lowest first (2 or more).'),
})

export interface DecisionToolOptions {
	/** Overrides the tool name (default `decide`). */
	name?: string
}

function round(n: number): string {
	return n.toFixed(4)
}

function distribution(probabilities: Record<string, number>): string {
	return Object.entries(probabilities)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k}=${round(v)}`)
		.join(', ')
}

const ADVISORY =
	'This is a fast, advisory System-1 judgment — you remain responsible for hard constraints; weigh low-confidence results with your own reasoning.'

/**
 * The agent-facing decision behaviour: one optional `decide` tool over any
 * {@link DecisionModel}. It is **fail-open** — a model error never surfaces as
 * a tool failure; the result tells the agent to proceed on its own reasoning.
 * A host that configures no decision model simply does not register this tool,
 * so the agent never sees it and its normal path is unchanged.
 */
export function createDecisionTool(model: DecisionModel, options: DecisionToolOptions = {}) {
	return defineTool({
		name: options.name ?? DECIDE_TOOL_NAME,
		description:
			'Ask a fast System-1 decision model for a typed judgment: a yes/no probability, a choice among options, or a score across ordered levels. ' +
			'Optional and advisory — reach for it when a quick, well-scoped classification, routing, safety pre-screen, element pick or ranking would help, then act on your own reasoning. ' +
			'If the model is unavailable the tool says so and you simply proceed.',
		inputSchema,
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,

		async execute(input, context) {
			const opts = context.abortSignal ? { signal: context.abortSignal } : undefined
			try {
				if (input.kind === 'yesno') {
					const { p } = await model.yesno(input.context, input.question, opts)
					return {
						success: true,
						output: `P(true) = ${round(p)}. ${ADVISORY}`,
						data: { kind: 'yesno', p },
					}
				}
				if (input.kind === 'choice') {
					const choices = input.options ?? []
					if (choices.length < 2) {
						return {
							success: true,
							output:
								'decide(choice) needs 2 or more `options`. None judged — decide with your own reasoning.',
						}
					}
					const { option, probabilities } = await model.choice(
						input.context,
						input.question,
						choices,
						opts,
					)
					return {
						success: true,
						output: `Pick: ${option}  (${distribution(probabilities)}). ${ADVISORY}`,
						data: { kind: 'choice', option, probabilities },
					}
				}
				const levels = input.levels ?? []
				if (levels.length < 2) {
					return {
						success: true,
						output:
							'decide(score) needs 2 or more `levels`. None judged — decide with your own reasoning.',
					}
				}
				const { level, probabilities } = await model.score(
					input.context,
					input.question,
					levels,
					opts,
				)
				const name = levels[level] ?? `level ${level}`
				return {
					success: true,
					output: `Score: ${name} (index ${level})  [${probabilities.map(round).join(', ')}]. ${ADVISORY}`,
					data: { kind: 'score', level, name, probabilities },
				}
			} catch (error) {
				// FAIL-OPEN: the decision model is optional. Never turn its outage
				// into a tool failure — report it as a successful "unavailable" so
				// the agent reads one line and continues on its normal path.
				const why = error instanceof DecisionError ? error.message : String(error)
				return {
					success: true,
					output: `The decision model is unavailable (${why}). Decide using your own reasoning; this tool is advisory only.`,
					data: { kind: 'unavailable', reason: why },
				}
			}
		},
	})
}
