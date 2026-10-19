import { type ToolDefinition, defineTool, mcpJsonSchemaToZod } from '@namzu/sdk'

import { permissionModeLabel } from '../permissions/mode.js'
import type { PermissionMode } from '../permissions/mode.js'
import {
	EXIT_PLAN_MODE_TOOL_NAME,
	type PlanApprovalAnswer,
	type PlanApprovalFn,
} from './approval.js'
import { readPlan } from './plan-file.js'

export interface ExitPlanModeHost {
	/** The mode decisions are made under right now. */
	readonly mode: () => PermissionMode
	/** The plan file for this session. */
	readonly planPath: () => string
	/** Whether the session may run without asking, which changes the first row of the dialog. */
	readonly bypassAvailable: () => boolean
	/** Who approves this turn's plan; absent means nobody can. */
	readonly approval: () => PlanApprovalFn | undefined
}

/** What the model reads when the person approves: where the plan is kept, and the plan itself. */
export function approvedPlanText(
	plan: string,
	planPath: string,
	answer: Extract<PlanApprovalAnswer, { kind: 'approve' }>,
): string {
	return [
		`The user approved your plan and moved this session to "${permissionModeLabel(answer.mode)}". You can start the work now; if a task list fits it, open one first.`,
		'',
		`The plan is saved at ${planPath} if you need to refer back to it.`,
		...(answer.feedback ? ['', `The user added: ${answer.feedback}`] : []),
		'',
		'## Approved plan',
		plan,
	].join('\n')
}

/**
 * `exit_plan_mode`: the model's way to put a finished plan in front of the
 * person. The plan is read from the plan file, not from the call, so what is
 * approved is exactly what is on disk. Mount it only where a person is present.
 */
export function buildExitPlanModeTool(host: ExitPlanModeHost): ToolDefinition {
	return defineTool({
		name: EXIT_PLAN_MODE_TOOL_NAME,
		description:
			'Present the finished plan for the user to approve and leave plan mode. Write the plan to the plan file first; this tool reads it from there and takes no arguments. The user picks how to continue (auto-approve edits, or ask before each edit) or sends you back to planning with feedback. Call it only while in plan mode, only when the plan is ready, and never ask for approval of a plan any other way.',
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {},
			additionalProperties: false,
		}),
		category: 'custom',
		permissions: [],
		// Asks the person, changes nothing itself: the mode switch is theirs.
		readOnly: true,
		destructive: false,
		concurrencySafe: false,
		// A person reads a whole plan before answering.
		timeoutMs: 30 * 60_000,
		presentCall: () => ({
			kind: 'generic',
			label: 'Present plan for approval',
			presentation: 'activity',
		}),
		// The transcript already shows the approved plan (the host writes it when the
		// person approves); the tool's own result is for the model.
		presentResult: (_input, result) => {
			if (result.success)
				return {
					kind: 'generic',
					label: 'Plan approved',
					visibility: 'hidden',
				}
			const outcome = (result.data as { outcome?: unknown } | undefined)?.outcome
			return outcome === 'keep-planning'
				? { kind: 'generic', label: 'Kept planning', outcome: 'cancelled' }
				: undefined
		},
		async execute(_input, context) {
			context.abortSignal?.throwIfAborted()
			if (host.mode() !== 'plan') {
				return {
					success: false,
					output: '',
					error:
						'You are not in plan mode, so there is no plan to put up for approval. If your plan was already approved, carry on with the work.',
				}
			}
			const planPath = host.planPath()
			const plan = await readPlan(planPath)
			if (plan === undefined) {
				return {
					success: false,
					output: '',
					error: `There is no plan to approve: ${planPath} is missing or empty. Write the plan to that file first, then call ${EXIT_PLAN_MODE_TOOL_NAME}.`,
				}
			}
			const ask = host.approval()
			if (!ask) {
				return {
					success: false,
					output: '',
					error:
						'Nobody can approve a plan in this session, and you cannot leave plan mode yourself. End your reply with the plan and tell the user to switch the permission mode when they want it carried out.',
				}
			}
			let answer: PlanApprovalAnswer
			try {
				answer = await ask(
					{ plan, planPath, bypassAvailable: host.bypassAvailable() },
					context.abortSignal,
				)
			} catch {
				answer = { kind: 'keep-planning' }
			}
			context.abortSignal?.throwIfAborted()
			if (answer.kind === 'approve') {
				return {
					success: true,
					output: approvedPlanText(plan, planPath, answer),
					data: { outcome: 'approved', mode: answer.mode },
				}
			}
			return {
				success: false,
				output: '',
				error: answer.feedback
					? `The user did not approve the plan and wants you to keep planning. What they said: ${answer.feedback}`
					: 'The user did not approve the plan yet and has not said what to change. Stay in plan mode and ask what they want different, or refine the plan.',
				data: { outcome: 'keep-planning' },
			}
		},
	})
}
