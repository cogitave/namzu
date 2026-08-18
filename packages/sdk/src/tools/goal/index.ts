import { z } from 'zod'

import { GoalNotFoundError, type SessionGoalStore, StaleGoalError } from '../../store/goal/index.js'
import type { GoalRoundAuthority, SessionGoal } from '../../types/goal/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

export const SESSION_GOAL_TOOL_NAMES = ['get_goal', 'update_goal'] as const
export const MIN_GOAL_BLOCK_ROUND = 3

/** Resolve authority captured for one caller-reserved run id. */
export type ResolveGoalRoundAuthority = (runId: RunId) => GoalRoundAuthority | null | undefined

/** A goal tool was reached outside the one run whose admission authorized it. */
export class GoalRoundAuthorityError extends Error {
	constructor(runId: RunId) {
		super(`Run ${runId} has no admitted goal-round authority.`)
		this.name = 'GoalRoundAuthorityError'
	}
}

async function currentGoal(
	store: SessionGoalStore,
	authority: GoalRoundAuthority,
): Promise<SessionGoal> {
	const goal = await store.getGoal(authority.sessionId, authority.tenantId)
	if (!goal) throw new GoalNotFoundError(authority.sessionId)
	if (goal.id !== authority.id || goal.revision !== authority.revision) {
		throw new StaleGoalError({
			sessionId: authority.sessionId,
			expectedRevision: authority.revision,
			actualRevision: goal.revision,
		})
	}
	return goal
}

function authorityFor(
	resolveAuthority: ResolveGoalRoundAuthority,
	runId: RunId,
): GoalRoundAuthority {
	const authority = resolveAuthority(runId)
	if (!authority) throw new GoalRoundAuthorityError(runId)
	return authority
}

/**
 * Run-scoped tools for an admitted SessionGoal round.
 *
 * Registration is not authorization. A host must also withhold these names
 * from every non-goal provider request and executor allow-list.
 */
export function buildSessionGoalTools(
	store: SessionGoalStore,
	resolveAuthority: ResolveGoalRoundAuthority,
): ToolDefinition[] {
	const getGoal = defineTool({
		name: 'get_goal',
		description:
			'Read the exact completion goal and admitted-round budget that authorized this automatic turn.',
		inputSchema: z.object({}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute(_input, context) {
			const authority = authorityFor(resolveAuthority, context.runId)
			const goal = await currentGoal(store, authority)
			return {
				success: true,
				output: JSON.stringify({
					id: goal.id,
					objective: goal.objective,
					phase: goal.phase,
					round: authority.round,
					maxGoalRounds: goal.maxGoalRounds,
					roundsAdmitted: goal.roundsAdmitted,
				}),
				data: goal,
			}
		},
	})

	const updateGoal = defineTool({
		name: 'update_goal',
		description:
			'Mark this admitted goal complete, or blocked after at least three admitted rounds. This does not end the turn; explain the final state to the operator afterward.',
		inputSchema: z.object({
			status: z.enum(['complete', 'blocked']),
			reasonCode: z
				.string()
				.optional()
				.describe('Lower-kebab-case reason code; required when status is blocked.'),
			reason: z.string().optional().describe('Operator-readable reason; required when blocked.'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: false,
		async execute({ status, reasonCode, reason }, context) {
			const authority = authorityFor(resolveAuthority, context.runId)
			await currentGoal(store, authority)
			const ref = { id: authority.id, revision: authority.revision }
			if (status === 'complete') {
				const goal = await store.completeGoal(authority.sessionId, authority.tenantId, ref)
				return { success: true, output: 'Goal marked complete.', data: goal }
			}

			if (authority.round < MIN_GOAL_BLOCK_ROUND) {
				throw new Error(
					`A goal cannot be marked blocked before admitted round ${MIN_GOAL_BLOCK_ROUND}; this is round ${authority.round}.`,
				)
			}
			if (!reasonCode || !reason) {
				throw new TypeError('Blocked goal updates require reasonCode and reason.')
			}
			const goal = await store.blockGoal(authority.sessionId, authority.tenantId, ref, {
				code: reasonCode,
				message: reason,
			})
			return { success: true, output: 'Goal marked blocked.', data: goal }
		},
	})

	return [getGoal, updateGoal]
}
