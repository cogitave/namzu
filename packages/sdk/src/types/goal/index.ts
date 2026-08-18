import type { GoalId, SessionId, TenantId } from '../ids/index.js'

/** Durable lifecycle of one same-session completion goal. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Machine-routable and human-readable reason that a goal stopped. */
export interface GoalBlockReason {
	/** Stable lower-kebab-case policy code. */
	readonly code: string
	/** Non-empty explanation suitable for an operator. */
	readonly message: string
}

/** Exact compare-and-set identity of one goal revision. */
export interface GoalRef {
	readonly id: GoalId
	readonly revision: number
}

/**
 * The current completion goal owned by one durable Session.
 *
 * `objective` is the text to achieve; “goal” is the stateful concept around
 * it. Keeping those terms apart prevents the old `TopicObjective` shape from
 * making a piece of text sound like the lifecycle that owns it.
 */
export interface SessionGoal extends GoalRef {
	readonly sessionId: SessionId
	readonly tenantId: TenantId
	readonly objective: string
	readonly phase: GoalPhase
	/** Present exactly while {@link phase} is `blocked`. */
	readonly blockedReason?: GoalBlockReason
	readonly createdAt: number
	readonly updatedAt: number
}
