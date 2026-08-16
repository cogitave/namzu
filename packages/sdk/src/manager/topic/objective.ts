import { ObjectiveExhaustedError, type TopicObjectiveStore } from '../../store/topic/objective.js'
import type { TenantId } from '../../types/ids/index.js'
import type {
	ObjectiveAdvanceResult,
	ObjectiveRoundVerdict,
	TopicObjective,
} from '../../types/topic/objective.js'

/**
 * One round of an objective, from debit to verdict.
 *
 * The store holds the rules and the manager holds the sequence, so a host
 * writes the work and not the bookkeeping. Getting that sequence wrong is
 * how a cap stops capping: run the round first and a crash costs nothing,
 * so an objective failing every round runs forever.
 */

export interface AdvanceObjectiveParams {
	readonly id: string
	readonly tenantId: TenantId
	/**
	 * The work. Its return value is the verdict; a throw is `runner_failed`.
	 *
	 * It receives the record with the round ALREADY debited, so a runner
	 * that wants to know which round it is reads the same number the cap
	 * will be compared against.
	 */
	readonly round: (objective: TopicObjective) => Promise<ObjectiveRoundVerdict>
}

/** Advance one round, or say why it did not. */
export async function advanceObjective(
	store: TopicObjectiveStore,
	params: AdvanceObjectiveParams,
): Promise<ObjectiveAdvanceResult> {
	const current = await store.getObjective(params.id, params.tenantId)
	if (!current) throw new Error(`No objective ${params.id}.`)

	if (current.phase !== 'active') {
		// A refusal rather than a throw. "Paused" and "already complete" are
		// ordinary answers to "is there more to do" — a caller polling a set
		// of objectives should not have to catch an exception per finished
		// one to find the running ones.
		return { kind: 'refused', reason: `Objective is ${current.phase}.`, phase: current.phase }
	}

	let debited: TopicObjective
	try {
		debited = await store.beginRound(params.id, params.tenantId, { revision: current.revision })
	} catch (error) {
		if (error instanceof ObjectiveExhaustedError) {
			// `beginRound` has already written the `blocked` phase, so this
			// reads the record back rather than describing it — the refusal a
			// caller sees and the record a later reader finds are then the same
			// fact rather than two statements that could disagree.
			const blocked = await store.getObjective(params.id, params.tenantId)
			return {
				kind: 'refused',
				reason: blocked?.blockedReason?.message ?? error.message,
				phase: blocked?.phase ?? 'blocked',
			}
		}
		throw error
	}

	let verdict: ObjectiveRoundVerdict
	try {
		verdict = await params.round(debited)
	} catch (error) {
		// Blocked, not lost. A runner that threw has left an objective whose
		// round is spent and whose state would otherwise still say `active`,
		// and the next poll would spend another round the same way.
		const settled = await store.settleRound(
			params.id,
			params.tenantId,
			{
				phase: 'blocked',
				blockedReason: {
					code: 'runner_failed',
					message: error instanceof Error ? error.message : String(error),
				},
			},
			{ revision: debited.revision },
		)
		return { kind: 'advanced', objective: settled }
	}

	const settled = await store.settleRound(params.id, params.tenantId, verdict, {
		revision: debited.revision,
	})
	return { kind: 'advanced', objective: settled }
}

export interface DriveObjectiveParams extends AdvanceObjectiveParams {
	/**
	 * Stop after this many rounds in THIS call.
	 *
	 * Separate from the objective's own `maxRounds`, which is durable and
	 * spans every call. This one bounds a single drive so a host can hand
	 * back to its caller — an objective with 200 rounds left should not
	 * decide how long one HTTP request takes.
	 *
	 * Omitted, the bound is the objective's OWN remaining rounds rather than
	 * no bound at all. See `driveObjective`.
	 */
	readonly maxRoundsThisCall?: number

	/**
	 * Checked between rounds, never mid-round.
	 *
	 * The interrupt a human actually gets: the round in flight finishes and
	 * writes its verdict, and the next one does not start. Aborting mid-round
	 * would leave a round debited whose work was thrown away, which is the
	 * one state the debit-first rule exists to prevent.
	 */
	readonly signal?: AbortSignal
}

/** A drive that ran a round and got no round out of it. */
export class ObjectiveNotProgressingError extends Error {
	readonly details: { id: string; roundsStarted: number }

	constructor(details: { id: string; roundsStarted: number }) {
		super(
			`Objective ${details.id} ran a round and roundsStarted stayed at ${details.roundsStarted}; refusing to loop.`,
		)
		this.name = 'ObjectiveNotProgressingError'
		this.details = details
	}
}

/**
 * Round after round until the objective stops asking for one.
 *
 * **The default bound is the objective's own remaining rounds, not
 * infinity.** An unbounded default was written here first and a mutation
 * test caught what it costs: break the round debit and this becomes a hot
 * loop that no timeout can interrupt, because with an in-memory store every
 * `await` in it resolves as a microtask and the event loop never reaches a
 * timer. It ran twelve minutes at 100% CPU against a five-second test
 * timeout that could never fire. Deriving the bound from `maxRounds` makes
 * the loop finite by construction, from a number the record already has to
 * carry.
 *
 * The progress check below is the second half of the same lesson: a bound
 * stops the spin, but it stops it silently after a hundred wasted rounds.
 */
export async function driveObjective(
	store: TopicObjectiveStore,
	params: DriveObjectiveParams,
): Promise<TopicObjective> {
	const start = await store.getObjective(params.id, params.tenantId)
	if (!start) throw new Error(`No objective ${params.id}.`)

	const remaining = Math.max(0, start.maxRounds - start.roundsStarted)
	// `remaining + 1`, and the `+ 1` is the point: it is the iteration that
	// asks for the round past the cap and is refused, which is what WRITES
	// the `blocked` record. Stopping at `remaining` would leave an objective
	// out of rounds still reading `active` — a state whose only remaining
	// move is to be blocked, described as if it could still run.
	//
	// The refused iteration costs nothing; `beginRound` turns it away before
	// the round callback is reached.
	//
	// A caller's own budget is the tighter bound when it gives one, and the
	// `Infinity` below never survives the `min` — that is what keeps this
	// finite by construction rather than by the caller remembering.
	const budget = Math.min(params.maxRoundsThisCall ?? Number.POSITIVE_INFINITY, remaining + 1)

	let rounds = 0
	let lastRoundsStarted = start.roundsStarted
	while (rounds < budget) {
		if (params.signal?.aborted) break
		const result = await advanceObjective(store, params)
		rounds += 1
		if (result.kind === 'refused') break

		// A round that did not advance the counter means the debit is broken,
		// and every further iteration would repeat it. Named and thrown rather
		// than left to the budget, so the failure says what it is instead of
		// looking like an objective that quietly ran out.
		if (result.objective.roundsStarted <= lastRoundsStarted) {
			throw new ObjectiveNotProgressingError({
				id: params.id,
				roundsStarted: result.objective.roundsStarted,
			})
		}
		lastRoundsStarted = result.objective.roundsStarted

		// An early exit, NOT a correctness guard, and it survives mutation for
		// that reason: delete it and the next iteration calls
		// `advanceObjective`, which reads the terminal phase and refuses, and
		// the drive ends in the same state having done one extra store read.
		// The refusal above is what makes stopping correct. This line only
		// makes it cheap — which against the disk store is a real file read
		// per completed drive, so it stays.
		if (result.objective.phase !== 'active') break
	}

	const final = await store.getObjective(params.id, params.tenantId)
	if (!final) throw new Error(`No objective ${params.id}.`)
	return final
}
