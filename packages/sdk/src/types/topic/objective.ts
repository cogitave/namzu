import type { RunId, TenantId, TopicId } from '../ids/index.js'

/**
 * Work that outlives one run.
 *
 * Nothing in this kernel survived a single `query()` call. `stopWhen` and
 * `prepareStep` shape one loop, the completion inbox holds one run open for
 * a worker, and the topic manager owned a container with no work state in
 * it at all — so a host wanting "keep going until X is done, stop safely if
 * it stalls or runs long, let a human pause and inspect" had to hand-roll
 * the store, the round cap and the compare-and-set outside the SDK.
 *
 * The Topic's own docstring already called it "one per objective or
 * line-of-work". This is that objective, written down.
 */

export type ObjectivePhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Why an objective stopped, in a form a caller can branch on. */
export interface ObjectiveBlock {
	/**
	 * A code, not just prose. `round_cap` and "the model gave up" are
	 * different situations with different next moves, and a message alone
	 * makes a host parse English to tell them apart.
	 */
	readonly code: 'round_cap' | 'runner_failed' | 'external'
	readonly message: string
}

export interface TopicObjective {
	readonly id: string
	readonly topicId: TopicId
	readonly tenantId: TenantId
	/** Compare-and-set counter, `0` before the first write. */
	readonly revision: number
	readonly objective: string
	readonly phase: ObjectivePhase
	readonly blockedReason?: ObjectiveBlock
	/**
	 * The hard stop.
	 *
	 * Not a suggestion and not a timeout: an objective that cannot tell it
	 * is stuck will keep spending money on rounds that make no progress, and
	 * a wall-clock bound stops a slow objective rather than a stalled one.
	 */
	readonly maxRounds: number
	/**
	 * Rounds BEGUN, not rounds finished.
	 *
	 * Debited before the work runs, so a round that crashes still counts. A
	 * counter that only advanced on success lets an objective failing every
	 * round spin forever, which is precisely the runaway the cap exists to
	 * stop.
	 */
	readonly roundsStarted: number
	readonly lastRunId?: RunId
	readonly updatedAt: number
}

/** A write whose `revision` no longer matches what is stored. */
export class StaleObjectiveError extends Error {
	readonly details: { id: string; expectedRevision: number; actualRevision: number }

	constructor(details: { id: string; expectedRevision: number; actualRevision: number }) {
		super(
			`Stale objective ${details.id}: expected revision=${details.expectedRevision}, actual=${details.actualRevision}`,
		)
		this.name = 'StaleObjectiveError'
		this.details = details
	}
}

/** Why an `advanceObjective` did nothing. */
export interface ObjectiveRefusal {
	readonly kind: 'refused'
	readonly reason: string
	readonly phase: ObjectivePhase
}

export interface ObjectiveAdvance {
	readonly kind: 'advanced'
	readonly objective: TopicObjective
}

export type ObjectiveAdvanceResult = ObjectiveAdvance | ObjectiveRefusal

/** What one round decided. */
export interface ObjectiveRoundVerdict {
	/** `undefined` leaves the phase alone: the round ran and said nothing. */
	readonly phase?: Extract<ObjectivePhase, 'complete' | 'blocked'>
	readonly blockedReason?: ObjectiveBlock
	readonly runId?: RunId
}
