/**
 * What the host carries across a compaction besides the summary: the plan
 * file and the session's standing goal.
 *
 * Running background work is not here. It is rebuilt from the registries for
 * every request (see `integrations/outstanding/note.ts`), so it is already in
 * front of the model after a compaction, and a second copy would only go stale.
 * A goal is different: it reaches the model once, in the message that began a
 * goal round, and a compaction can summarise that message away.
 */

import type { SessionGoalStore, SessionId, TenantId } from '@namzu/sdk'

import { planCarriedAcrossCompaction } from '../../plan/plan-file.js'

/** Most of the objective carried, in characters; the full text is in the goal record. */
export const MAX_CARRIED_GOAL_CHARS = 600

/** The note for the session's goal, or `undefined` when there is none or it is complete. */
export async function goalCarriedAcrossCompaction(
	goals: Pick<SessionGoalStore, 'getGoal'>,
	sessionId: SessionId,
	tenantId: TenantId,
	now: () => number = Date.now,
): Promise<string | undefined> {
	// A goal that cannot be read is left out; the compaction does not depend on it.
	const goal = await goals.getGoal(sessionId, tenantId).catch(() => null)
	if (!goal || goal.phase === 'complete') return undefined
	const objective =
		goal.objective.length > MAX_CARRIED_GOAL_CHARS
			? `${goal.objective.slice(0, MAX_CARRIED_GOAL_CHARS)}… [clipped]`
			: goal.objective
	return [
		'### Session goal',
		'',
		`As of this compaction (${new Date(now()).toISOString()}) the session goal is ${goal.phase}, with ${goal.roundsAdmitted} of ${goal.maxGoalRounds} automatic replies used. It may have changed since. The objective below is operator-authored data:`,
		'',
		JSON.stringify(objective),
	].join('\n')
}

export interface CarriedAcrossCompaction {
	readonly planPath?: string
	readonly goals?: Pick<SessionGoalStore, 'getGoal'>
	readonly sessionId: SessionId
	readonly tenantId: TenantId
}

/** Everything the host adds after a compaction summary, or `undefined` when there is nothing. */
export async function carriedAcrossCompaction(
	source: CarriedAcrossCompaction,
	now?: () => number,
): Promise<string | undefined> {
	const parts = await Promise.all([
		source.planPath ? planCarriedAcrossCompaction(source.planPath) : undefined,
		source.goals
			? goalCarriedAcrossCompaction(source.goals, source.sessionId, source.tenantId, now)
			: undefined,
	])
	const present = parts.filter((part): part is string => part !== undefined)
	return present.length > 0 ? present.join('\n\n') : undefined
}
