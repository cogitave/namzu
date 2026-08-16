import { describe, expect, it } from 'vitest'

import {
	InMemoryTopicObjectiveStore,
	type TopicObjectiveStore,
} from '../../../store/topic/objective.js'
import type { TenantId } from '../../../types/ids/index.js'
import type { TopicId } from '../../../types/session/ids.js'
import type { ObjectiveRoundVerdict } from '../../../types/topic/objective.js'
import { ObjectiveNotProgressingError, driveObjective } from '../objective.js'

/**
 * A drive that could not run away, and could be stopped by a human.
 *
 * The bound came from a mutation, not from a design review. `driveObjective`
 * was first written with `maxRoundsThisCall ?? Number.POSITIVE_INFINITY`, and
 * breaking the round debit turned it into a hot loop no timeout could
 * interrupt: with an in-memory store every `await` resolves as a microtask,
 * so the event loop never reaches a timer and the five-second test timeout
 * could not fire. It spun for twelve minutes at 100% CPU.
 *
 * So both halves are pinned here — that the bound exists without a caller
 * supplying one, and that a broken debit is NAMED rather than absorbed by
 * the bound.
 */

const TOPIC = 'top_drive' as TopicId
const TENANT = 'tnt_drive' as TenantId

const keepGoing: ObjectiveRoundVerdict = {}

const seed = (store: TopicObjectiveStore, maxRounds: number) =>
	store.createObjective({ id: 'obj_d', topicId: TOPIC, objective: 'keep going', maxRounds }, TENANT)

/**
 * The defect the mutation stood in for, as a store.
 *
 * `beginRound` advances the revision so every compare-and-set keeps
 * succeeding, and leaves `roundsStarted` alone. Nothing else about it is
 * wrong — which is what makes it the dangerous shape: the cap it is
 * measured against is never reached, so the objective is immortal.
 */
class NeverDebits extends InMemoryTopicObjectiveStore {
	override async beginRound(id: string, tenantId: TenantId, opts: { revision: number }) {
		const existing = await this.getObjective(id, tenantId)
		if (!existing) throw new Error(`No objective ${id}.`)
		if (existing.revision !== opts.revision) throw new Error('stale')
		const record = { ...existing, revision: existing.revision + 1 }
		await this.put(record)
		return record
	}
}

/**
 * The other half of the same danger: the debit works, the cap does not.
 *
 * This store exists because two guards were each masking the other's
 * mutation. Break only the cap and the derived budget stops the loop; break
 * only the budget and the cap stops it — so each mutation alone looked
 * survivable and neither guard could be shown to carry its own weight. This
 * removes the cap so the budget is the only thing left holding the loop.
 */
class NeverBlocks extends InMemoryTopicObjectiveStore {
	override async beginRound(id: string, tenantId: TenantId, opts: { revision: number }) {
		const existing = await this.getObjective(id, tenantId)
		if (!existing) throw new Error(`No objective ${id}.`)
		if (existing.revision !== opts.revision) throw new Error('stale')
		const record = {
			...existing,
			revision: existing.revision + 1,
			roundsStarted: existing.roundsStarted + 1,
		}
		await this.put(record)
		return record
	}
}

describe('a drive is bounded even when nobody bounds it', () => {
	it('stops at the objective cap with no per-call budget at all', async () => {
		// The regression. No `maxRoundsThisCall`, a round that never says
		// stop: the objective's own cap has to be what ends this.
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 4)

		const final = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async () => keepGoing,
		})

		expect(final).toMatchObject({ roundsStarted: 4, phase: 'blocked' })
	})

	it('leaves the record blocked rather than active-with-nothing-left', async () => {
		// The `+ 1` iteration. An objective out of rounds that still reads
		// `active` describes a state whose only remaining move is to be
		// blocked as though it could still run.
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 2)

		const final = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async () => keepGoing,
		})

		expect(final.phase).toBe('blocked')
		expect(final.blockedReason).toMatchObject({ code: 'round_cap' })
	})

	it('runs the round callback exactly as many times as the cap allows', async () => {
		// The refused iteration must cost nothing: `beginRound` turns it away
		// before the callback is reached.
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 3)
		let calls = 0

		await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async () => {
				calls += 1
				return keepGoing
			},
		})

		expect(calls).toBe(3)
	})

	it('honours a caller budget tighter than the cap', async () => {
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 50)

		const final = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			maxRoundsThisCall: 3,
			round: async () => keepGoing,
		})

		expect(final).toMatchObject({ roundsStarted: 3, phase: 'active' })
	})

	it('will not let a caller budget exceed the cap', async () => {
		// A caller asking for 500 rounds against a 2-round objective is asking
		// for rounds `beginRound` refuses; the drive should not spend 498
		// iterations discovering that.
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 2)

		const final = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			maxRoundsThisCall: 500,
			round: async () => keepGoing,
		})

		expect(final).toMatchObject({ roundsStarted: 2, phase: 'blocked' })
	})

	it('names a broken debit instead of looping on it', async () => {
		// The mutation that started this, as a permanent test. A store whose
		// `beginRound` does not advance the counter is the exact shape of the
		// hot loop; the drive must say so rather than spin or quietly stop.
		const store = new NeverDebits()
		const created = await seed(store, 10)

		await expect(
			driveObjective(store, {
				id: created.id,
				tenantId: TENANT,
				round: async () => keepGoing,
			}),
		).rejects.toThrow(ObjectiveNotProgressingError)
	})

	it('terminates on its own budget when the cap is not there to stop it', async () => {
		// The budget standing alone. With the store's cap removed, nothing
		// downstream ends this loop — if the bound were `Infinity` again it
		// would spin, and it would spin in the way no timeout can interrupt.
		const store = new NeverBlocks()
		const created = await seed(store, 6)

		const final = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async () => keepGoing,
		})

		// `remaining + 1`: six rounds plus the one that would have been
		// refused had the cap been working.
		expect(final.roundsStarted).toBe(7)
	})

	it('measures what is LEFT, not the cap, when rounds are already spent', async () => {
		// Same store, an objective part-way through. A budget computed from
		// `maxRounds` rather than `maxRounds - roundsStarted` would hand out
		// the whole allowance a second time on every resume — an objective
		// that never actually ends.
		const store = new NeverBlocks()
		const created = await seed(store, 6)
		await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			maxRoundsThisCall: 4,
			round: async () => keepGoing,
		})

		const final = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async () => keepGoing,
		})

		// 4 spent, 2 left, plus the would-be-refused one.
		expect(final.roundsStarted).toBe(7)
	})
})

describe('a human can interrupt a drive', () => {
	it('finishes the round in flight and does not start the next', async () => {
		// Not mid-round. Aborting mid-round leaves a round debited whose work
		// was thrown away — the state the debit-first rule exists to prevent.
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 20)
		const controller = new AbortController()
		const verdicts: number[] = []

		const final = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			signal: controller.signal,
			round: async (objective) => {
				verdicts.push(objective.roundsStarted)
				if (objective.roundsStarted === 2) controller.abort()
				return keepGoing
			},
		})

		// Round 2 ran to completion; round 3 never started.
		expect(verdicts).toEqual([1, 2])
		expect(final).toMatchObject({ roundsStarted: 2, phase: 'active' })
	})

	it('stops before the first round when the signal is already aborted', async () => {
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 5)
		let ran = false

		const final = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			signal: AbortSignal.abort(),
			round: async () => {
				ran = true
				return keepGoing
			},
		})

		expect(ran).toBe(false)
		expect(final).toMatchObject({ roundsStarted: 0, phase: 'active' })
	})

	it('notices a pause written by somebody else between rounds', async () => {
		// The other interrupt, and the one that survives a process restart:
		// a second host writes `paused` to the record and this drive stops
		// because it re-reads the phase, not because it was told.
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 20)

		const final = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async (objective) => {
				if (objective.roundsStarted === 2) {
					await store.setPhase(created.id, TENANT, 'paused', { revision: objective.revision })
					// The settle that follows this verdict now holds a stale
					// revision, which is the honest outcome: the pause won.
					return keepGoing
				}
				return keepGoing
			},
		}).catch((error: unknown) => error)

		// Either the settle refuses as stale or the next iteration reads
		// `paused` — both stop the drive, and neither leaves it running.
		const record = await store.getObjective(created.id, TENANT)
		expect(record?.phase).toBe('paused')
		expect(final).toBeDefined()
	})

	it('resumes after a pause is lifted', async () => {
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 20)
		const paused = await store.setPhase(created.id, TENANT, 'paused', {
			revision: created.revision,
		})

		const stopped = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async () => keepGoing,
		})
		expect(stopped.roundsStarted).toBe(0)

		await store.setPhase(created.id, TENANT, 'active', { revision: paused.revision })
		const resumed = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			maxRoundsThisCall: 2,
			round: async () => keepGoing,
		})

		expect(resumed).toMatchObject({ roundsStarted: 2, phase: 'active' })
	})
})
