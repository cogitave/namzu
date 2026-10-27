import { type ToolDefinition, defineTool, mcpJsonSchemaToZod } from '@namzu/sdk'

import type { PermissionMode } from '../permissions/mode.js'
import type { QuestionAnswer, QuestionFn, UserQuestion } from '../tui/agent.js'
import { ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from './approval.js'

export interface EnterPlanModeHost {
	/** The mode decisions are made under right now. */
	readonly mode: () => PermissionMode
	/** The plan file for this session. */
	readonly planPath: () => string
	/** Who answers a question this turn; absent means nobody can be asked. */
	readonly ask: () => QuestionFn | undefined
	/** Switch the session to plan mode; the host announces it. */
	readonly enter: () => void | Promise<void>
}

const YES = 'plan-first'
const NO = 'go-ahead'

/** The question the person answers before the session changes mode. */
export function enterPlanModeQuestion(): UserQuestion {
	return {
		questionId: 'enter-plan-mode',
		question: 'Enter plan mode?',
		header: 'Plan first',
		options: [
			{
				id: YES,
				label: 'Yes, plan first',
				description:
					'Namzu reads and explores without changing anything, then shows a plan for your approval.',
				recommended: true,
			},
			{
				id: NO,
				label: 'No, go ahead',
				description: 'Namzu carries on with the change as it is.',
			},
		],
		multiSelect: false,
		allowFreeText: false,
	}
}

/** What the model reads once plan mode is on: what to do now, and where the plan goes. */
export function enteredPlanModeText(planPath: string): string {
	return [
		'Plan mode is on. Explore the codebase and design the approach without changing any file except the plan file.',
		'',
		'In plan mode:',
		'1. Read the code that the change touches and the patterns it should follow.',
		'2. Compare the realistic approaches and their trade-offs.',
		'3. Ask the user, with ask_user_question, whatever only they can decide.',
		`4. Write the plan to ${planPath}.`,
		`5. Present it with ${EXIT_PLAN_MODE_TOOL_NAME}; the user approves it or sends it back with changes.`,
	].join('\n')
}

/** What the model reads when the person chose to go ahead without planning. */
export const DECLINED_PLAN_MODE_TEXT =
	'The user chose not to plan first. Carry on with the change directly, and ask when something needs their decision.'

const NOBODY_TO_ASK_TEXT =
	'Nobody can be asked about plan mode in this session. Carry on with the change directly.'

/**
 * `enter_plan_mode`: the model proposes planning before a change that is not
 * small, and the person decides. Deferred, so most turns never carry its
 * description. Nothing changes unless the person says yes: in `auto` and
 * `plan` the question is skipped (the person already chose how much to be
 * asked, or the session is planning), and every other mode asks.
 */
export function buildEnterPlanModeTool(host: EnterPlanModeHost): ToolDefinition {
	return defineTool({
		name: ENTER_PLAN_MODE_TOOL_NAME,
		description: `Ask the user to switch to plan mode before a change that is not small. In plan mode you explore read-only and present a plan for approval. Use it for a new feature, a change that has several reasonable approaches, an edit that spans several files or alters existing behaviour, an architectural choice, or a task whose scope you must explore first. Skip it for a one-line fix, a single function with clear requirements, a change the user has already specified in detail, and pure research. It takes no arguments and returns whether plan mode is on. Once on, write the plan to the plan file and present it with ${EXIT_PLAN_MODE_TOOL_NAME}.`,
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {},
			additionalProperties: false,
		}),
		category: 'custom',
		permissions: [],
		// Asks the person and changes nothing until they agree.
		readOnly: true,
		destructive: false,
		concurrencySafe: false,
		timeoutMs: 30 * 60_000,
		presentCall: () => ({
			kind: 'generic',
			label: 'Propose planning first',
			presentation: 'activity',
		}),
		presentResult: (_input, result) => {
			const outcome = (result.data as { outcome?: unknown } | undefined)?.outcome
			if (result.success && outcome === 'entered')
				return { kind: 'generic', label: 'Plan mode on', visibility: 'hidden' }
			return outcome === 'declined'
				? { kind: 'generic', label: 'Going ahead without a plan', outcome: 'cancelled' }
				: undefined
		},
		async execute(_input, context) {
			context.abortSignal?.throwIfAborted()
			const mode = host.mode()
			if (mode === 'plan') {
				return {
					success: true,
					output:
						'Plan mode is already on. Keep exploring, then present the plan with exit_plan_mode.',
					data: { outcome: 'already' },
				}
			}
			// Auto is the mode in which the person asked not to be consulted per
			// step; every other mode asks.
			if (mode !== 'classify') {
				const ask = host.ask()
				if (!ask) {
					return {
						success: false,
						output: '',
						error: NOBODY_TO_ASK_TEXT,
						data: { outcome: 'declined' },
					}
				}
				let answer: QuestionAnswer
				try {
					answer = await ask(enterPlanModeQuestion(), context.abortSignal)
				} catch {
					answer = { kind: 'skip' }
				}
				context.abortSignal?.throwIfAborted()
				const chosen = answer.kind === 'answer' && answer.selectedOptionIds.includes(YES)
				if (!chosen) {
					return {
						success: false,
						output: '',
						error: DECLINED_PLAN_MODE_TEXT,
						data: { outcome: 'declined' },
					}
				}
			}
			await host.enter()
			return {
				success: true,
				output: enteredPlanModeText(host.planPath()),
				data: { outcome: 'entered' },
			}
		},
	})
}
