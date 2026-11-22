import type { GoalId, SessionId, TenantId } from '../ids/index.js'

/** Durable lifecycle of one same-session completion goal. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/**
 * Who says a goal is done. `model`: the model's own report ends the goal, as it
 * always has. `record`: the kernel reads the record of the work done for the
 * goal first, and the goal ends only as that record allows.
 */
export type GoalConfirmedBy = 'model' | 'record'

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
	/** Finite number of automatic rounds that may be admitted for this goal. */
	readonly maxGoalRounds: number
	/** Durable admissions, not a claim that the provider began or completed. */
	readonly roundsAdmitted: number
	/**
	 * What this goal was created to be confirmed by. Absent means the host's own
	 * setting decides, which is the case for every goal created before this
	 * field existed.
	 */
	readonly confirmedBy?: GoalConfirmedBy
	/** Present exactly while {@link phase} is `blocked`. */
	readonly blockedReason?: GoalBlockReason
	/** Present while {@link phase} is `paused` because the goal reached a check-in. */
	readonly pauseReason?: GoalBlockReason
	/**
	 * Stop rules chosen when the goal was created. Absent means the rule is not
	 * applied, which is how every goal created before they existed behaves.
	 */
	readonly guards?: GoalGuards
	/** Tokens spent by the goal's automatic turns so far. */
	readonly tokensUsed?: number
	/** What those turns cost, in USD, as far as it could be priced. */
	readonly costUsd?: number
	/** Automatic turns in a row that did nothing the record can show. */
	readonly quietRounds?: number
	/** Automatic turns in a row that ended on the same failure. */
	readonly failureRounds?: number
	/** The failure those turns ended on. */
	readonly failureSignature?: string
	/** What the most recent turn that did something did, in a few words. */
	readonly lastAction?: string
	/** The admitted round at which the last check-in pause was made. */
	readonly checkedInAtRound?: number
	/** The admitted round that was given as the last one because the token budget was reached. */
	readonly wrapUpRound?: number
	/** What a check of the completion report found missing; leads the next round. */
	readonly missing?: readonly string[]
	readonly createdAt: number
	readonly updatedAt: number
}

/**
 * The rules that stop a goal that is not getting anywhere or has spent what it
 * was allowed. Every field is optional and an absent one is not applied.
 */
export interface GoalGuards {
	/** Stop (block) after this many automatic turns in a row that changed nothing, or that ended on the same failure. */
	readonly stallRounds?: number
	/** Pause for a check-in after this many admitted rounds, and again after each further batch. `0` turns it off. */
	readonly checkInEvery?: number
	/** Tokens the goal's automatic turns may spend; one last round is given when it is reached. */
	readonly tokenBudget?: number
}

/** What one finished automatic turn did, as the host read it from the turn's record. */
export interface GoalRoundOutcome {
	/** Tokens the turn spent, when known. */
	readonly tokens?: number
	/** What the turn cost in USD, when it could be priced. */
	readonly costUsd?: number
	/** `empty`: nothing changed, no check ran, no completion was claimed. `unknown`: the record cannot tell. */
	readonly progress: 'progress' | 'empty' | 'unknown'
	/** The failure the turn ended on, as a stable short string; absent when it did not end on one. */
	readonly failureSignature?: string
	/** What the turn did, in a few words, for the line that says why a goal stopped. */
	readonly action?: string
	/** What a check of the completion report found missing. An empty list clears it. */
	readonly missing?: readonly string[]
}

/** Immutable authority carried by exactly one admitted automatic turn. */
export interface GoalRoundAuthority extends GoalRef {
	readonly sessionId: SessionId
	readonly tenantId: TenantId
	readonly objective: string
	/** One-based admitted round number. */
	readonly round: number
	readonly maxGoalRounds: number
	/** Tokens and cost (USD) the goal's earlier automatic turns used, when any were recorded. */
	readonly tokensUsed?: number
	readonly costUsd?: number
	/** This round is the last one: the token budget was reached and the model is to wrap up. */
	readonly wrapUp?: boolean
	/** What a check of an earlier completion report found missing; leads this round. */
	readonly missing?: readonly string[]
}
