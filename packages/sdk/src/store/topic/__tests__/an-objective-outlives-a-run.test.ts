import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { advanceObjective, driveObjective } from '../../../manager/topic/objective.js'
import { TenantIsolationError } from '../../../session/errors.js'
import type { TenantId } from '../../../types/ids/index.js'
import type { TopicId } from '../../../types/session/ids.js'
import {
	type ObjectiveRoundVerdict,
	StaleObjectiveError,
	type TopicObjective,
} from '../../../types/topic/objective.js'
import {
	DiskTopicObjectiveStore,
	InMemoryTopicObjectiveStore,
	ObjectiveExhaustedError,
	ObjectiveExistsError,
	type TopicObjectiveStore,
} from '../objective.js'

/**
 * Work that outlives one run.
 *
 * Nothing in this kernel survived a single `query()` call, so a host wanting
 * "keep going until X is done, stop if it stalls, let a human pause it"
 * hand-rolled the store, the round cap and the compare-and-set outside the
 * SDK. These are the properties that make the cap a cap rather than a
 * suggestion.
 */

const TOPIC = 'top_obj' as TopicId
const TENANT = 'tnt_obj' as TenantId
const OTHER = 'tnt_other' as TenantId

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function diskStore(): Promise<DiskTopicObjectiveStore> {
	const rootDir = await mkdtemp(join(tmpdir(), 'namzu-objective-'))
	dirs.push(rootDir)
	return new DiskTopicObjectiveStore({ rootDir })
}

const seed = (store: TopicObjectiveStore, maxRounds = 3) =>
	store.createObjective(
		{ id: 'obj_1', topicId: TOPIC, objective: 'migrate the tests', maxRounds },
		TENANT,
	)

const done: ObjectiveRoundVerdict = { phase: 'complete' }
const keepGoing: ObjectiveRoundVerdict = {}

describe.each([
	['in-memory', async (): Promise<TopicObjectiveStore> => new InMemoryTopicObjectiveStore()],
	['disk', async (): Promise<TopicObjectiveStore> => await diskStore()],
])('%s: an objective survives its rounds', (_name, make) => {
	it('starts active, with nothing spent', async () => {
		const store = await make()

		const created = await seed(store)

		expect(created).toMatchObject({ phase: 'active', roundsStarted: 0, revision: 1 })
	})

	it('refuses a second create on the same id', async () => {
		// An overwrite would reset `roundsStarted` — the one field whose job
		// is to be un-resettable by the thing it caps.
		const store = await make()
		await seed(store)

		await expect(seed(store)).rejects.toThrow(ObjectiveExistsError)
	})

	it('admits exactly one of two simultaneous creates', async () => {
		const store = await make()

		const results = await Promise.allSettled([seed(store), seed(store)])

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		const rejected = results.filter((result) => result.status === 'rejected')
		expect(rejected).toHaveLength(1)
		expect(rejected[0]).toMatchObject({ reason: expect.any(ObjectiveExistsError) })
		expect(await store.getObjective('obj_1', TENANT)).toMatchObject({
			revision: 1,
			roundsStarted: 0,
		})
	})

	it('debits the round BEFORE the work runs', async () => {
		// The whole property. A counter advanced on success lets an objective
		// that fails every round run forever.
		const store = await make()
		const created = await seed(store)

		let seenInsideRound: number | undefined
		await advanceObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async (objective) => {
				seenInsideRound = objective.roundsStarted
				throw new Error('the runner died')
			},
		})

		expect(seenInsideRound).toBe(1)
		expect((await store.getObjective(created.id, TENANT))?.roundsStarted).toBe(1)
	})

	it('blocks a runner failure rather than leaving it active', async () => {
		// Left active, the next poll spends another round the same way.
		const store = await make()
		const created = await seed(store)

		await advanceObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async () => {
				throw new Error('provider refused')
			},
		})

		expect(await store.getObjective(created.id, TENANT)).toMatchObject({
			phase: 'blocked',
			blockedReason: { code: 'runner_failed', message: 'provider refused' },
		})
	})

	it('blocks at the cap, and says so on the record', async () => {
		const store = await make()
		const created = await seed(store, 2)

		await driveObjective(store, { id: created.id, tenantId: TENANT, round: async () => keepGoing })

		const final = await store.getObjective(created.id, TENANT)
		expect(final).toMatchObject({
			phase: 'blocked',
			roundsStarted: 2,
			blockedReason: { code: 'round_cap' },
		})
	})

	it('writes the blocked phase even when the caller swallows the throw', async () => {
		// A record that still said `active` after the cap bit would have the
		// next reader start the round this refused.
		const store = await make()
		const created = await seed(store, 1)
		const first = await store.beginRound(created.id, TENANT, { revision: created.revision })

		await expect(
			store.beginRound(created.id, TENANT, { revision: first.revision }),
		).rejects.toThrow(ObjectiveExhaustedError)

		expect((await store.getObjective(created.id, TENANT))?.phase).toBe('blocked')
	})

	it('refuses a write against a stale revision', async () => {
		const store = await make()
		const created = await seed(store)
		await store.beginRound(created.id, TENANT, { revision: created.revision })

		await expect(
			store.beginRound(created.id, TENANT, { revision: created.revision }),
		).rejects.toThrow(StaleObjectiveError)
	})

	it('debits exactly one of two simultaneous rounds at one revision', async () => {
		const store = await make()
		const created = await seed(store)

		const results = await Promise.allSettled([
			store.beginRound(created.id, TENANT, { revision: created.revision }),
			store.beginRound(created.id, TENANT, { revision: created.revision }),
		])

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		const rejected = results.filter((result) => result.status === 'rejected')
		expect(rejected).toHaveLength(1)
		expect(rejected[0]).toMatchObject({ reason: expect.any(StaleObjectiveError) })
		expect(await store.getObjective(created.id, TENANT)).toMatchObject({
			revision: 2,
			roundsStarted: 1,
		})
	})

	it('will not reopen a complete objective', async () => {
		// The rounds it would run against are the ones already spent.
		const store = await make()
		const created = await seed(store)
		const finished = await store.settleRound(created.id, TENANT, done, {
			revision: created.revision,
		})

		await expect(
			store.setPhase(created.id, TENANT, 'active', { revision: finished.revision }),
		).rejects.toThrow(/complete/)
	})

	it('drops the blocked reason when it goes active again', async () => {
		// A stale sentence is what an operator reads to decide whether to
		// intervene.
		const store = await make()
		const created = await seed(store)
		await advanceObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async () => {
				throw new Error('transient')
			},
		})
		const blocked = (await store.getObjective(created.id, TENANT)) as TopicObjective

		const resumed = await store.setPhase(created.id, TENANT, 'active', {
			revision: blocked.revision,
		})

		expect(resumed.blockedReason).toBeUndefined()
		expect((await store.getObjective(created.id, TENANT))?.blockedReason).toBeUndefined()
	})

	it('refuses a round on a paused objective, called directly', async () => {
		// `advanceObjective` guards this too, but `beginRound` is a public
		// store method and a host may drive its own loop with it. Reached that
		// way, a paused objective would spend a round nobody authorised — and
		// the pause is the one control a human has over a running objective.
		const store = await make()
		const created = await seed(store)
		const paused = await store.setPhase(created.id, TENANT, 'paused', {
			revision: created.revision,
		})

		await expect(
			store.beginRound(created.id, TENANT, { revision: paused.revision }),
		).rejects.toThrow(/paused/)
		expect((await store.getObjective(created.id, TENANT))?.roundsStarted).toBe(0)
	})

	it('reads as absent to another tenant', async () => {
		const store = await make()
		const created = await seed(store)

		expect(await store.getObjective(created.id, OTHER)).toBeNull()
	})

	it('refuses another tenant mutation instead of overwriting the hidden objective', async () => {
		const store = await make()
		const created = await seed(store)

		await expect(
			store.setPhase(created.id, OTHER, 'paused', { revision: created.revision }),
		).rejects.toBeInstanceOf(TenantIsolationError)
		expect(await store.getObjective(created.id, TENANT)).toMatchObject({
			phase: 'active',
			revision: 1,
		})
	})

	it('refuses a cap below one', async () => {
		// A record that blocks on its own first round reads as a runaway that
		// was stopped rather than as a caller mistake.
		const store = await make()

		await expect(seed(store, 0)).rejects.toThrow(/maxRounds/)
	})

	it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		'refuses a non-safe-integer cap (%s)',
		async (maxRounds) => {
			const store = await make()

			await expect(seed(store, maxRounds)).rejects.toThrow(/positive safe integer/)
		},
	)
})

describe('the shared objective transitions keep their commit seam', () => {
	it('routes every built-in mutation through a subclass put observer', async () => {
		class ObservedObjectiveStore extends InMemoryTopicObjectiveStore {
			writes = 0

			protected override async put(record: TopicObjective): Promise<void> {
				this.writes++
				await super.put(record)
			}
		}

		const store = new ObservedObjectiveStore()
		const created = await seed(store)
		const begun = await store.beginRound(created.id, TENANT, { revision: created.revision })
		await store.settleRound(created.id, TENANT, done, { revision: begun.revision })

		expect(store.writes).toBe(3)
	})
})

describe('a paused objective is refused, not thrown at', () => {
	it('answers with the phase rather than an exception', async () => {
		// A caller polling many objectives should not catch an exception per
		// finished one to find the running ones.
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store)
		const paused = await store.setPhase(created.id, TENANT, 'paused', {
			revision: created.revision,
		})

		let ran = false
		const result = await advanceObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async () => {
				ran = true
				return keepGoing
			},
		})

		expect(result).toMatchObject({ kind: 'refused', phase: 'paused' })
		expect(ran).toBe(false)
		expect((await store.getObjective(created.id, TENANT))?.revision).toBe(paused.revision)
	})
})

describe('driving stops for the right reasons', () => {
	it('stops when a round says complete, without spending the rest', async () => {
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 10)

		const final = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			round: async (objective) => (objective.roundsStarted >= 3 ? done : keepGoing),
		})

		expect(final).toMatchObject({ phase: 'complete', roundsStarted: 3 })
	})

	it('hands back at the per-call budget with the objective still active', async () => {
		// The durable cap spans every call; this one bounds a single drive, so
		// an objective with rounds left does not decide how long one request
		// takes.
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 100)

		const final = await driveObjective(store, {
			id: created.id,
			tenantId: TENANT,
			maxRoundsThisCall: 4,
			round: async () => keepGoing,
		})

		expect(final).toMatchObject({ phase: 'active', roundsStarted: 4 })
	})

	it('resumes on the next call from where the last one stopped', async () => {
		const store = new InMemoryTopicObjectiveStore()
		const created = await seed(store, 100)
		const params = { id: created.id, tenantId: TENANT, round: async () => keepGoing }

		await driveObjective(store, { ...params, maxRoundsThisCall: 4 })
		const final = await driveObjective(store, { ...params, maxRoundsThisCall: 3 })

		// 7, not 3: the count is durable, which is the point of the record.
		expect(final.roundsStarted).toBe(7)
	})
})

describe('the objective survives the store instance that wrote it', () => {
	it('is read back by a fresh store over the same directory', async () => {
		const rootDir = await mkdtemp(join(tmpdir(), 'namzu-objective-disk-'))
		dirs.push(rootDir)
		const created = await seed(new DiskTopicObjectiveStore({ rootDir }), 5)
		await driveObjective(new DiskTopicObjectiveStore({ rootDir }), {
			id: created.id,
			tenantId: TENANT,
			maxRoundsThisCall: 2,
			round: async () => keepGoing,
		})

		const reread = await new DiskTopicObjectiveStore({ rootDir }).getObjective(created.id, TENANT)

		expect(reread).toMatchObject({
			roundsStarted: 2,
			phase: 'active',
			objective: 'migrate the tests',
		})
	})

	it('reads a legacy snapshot forward into the immutable revision log', async () => {
		const rootDir = await mkdtemp(join(tmpdir(), 'namzu-objective-legacy-'))
		dirs.push(rootDir)
		const objectiveDir = join(rootDir, 'objectives')
		await mkdir(objectiveDir, { recursive: true })
		const legacy: TopicObjective = {
			id: 'obj.legacy',
			topicId: TOPIC,
			tenantId: TENANT,
			revision: 3,
			objective: 'survive the upgrade',
			phase: 'active',
			maxRounds: 5,
			roundsStarted: 1,
			updatedAt: 1,
		}
		await writeFile(join(objectiveDir, 'obj.legacy.json'), JSON.stringify(legacy), 'utf-8')
		const store = new DiskTopicObjectiveStore({ rootDir })

		const next = await store.beginRound(legacy.id, TENANT, { revision: legacy.revision })

		expect(next).toMatchObject({ revision: 4, roundsStarted: 2 })
		const committed = JSON.parse(
			await readFile(join(objectiveDir, '.revisions', 'obj~002elegacy', '4.json'), 'utf-8'),
		) as TopicObjective
		expect(committed).toMatchObject({ revision: 4, roundsStarted: 2, schemaVersion: 1 })
		const projection = JSON.parse(
			await readFile(join(objectiveDir, 'obj.legacy.json'), 'utf-8'),
		) as TopicObjective
		expect(projection).toEqual(committed)
	})

	it('accepts a legacy projection behind the immutable head after a crash window', async () => {
		const rootDir = await mkdtemp(join(tmpdir(), 'namzu-objective-behind-'))
		dirs.push(rootDir)
		const store = new DiskTopicObjectiveStore({ rootDir })
		const created = await seed(store)
		await store.beginRound(created.id, TENANT, { revision: created.revision })
		await writeFile(
			join(rootDir, 'objectives', 'obj_1.json'),
			JSON.stringify({ ...created, schemaVersion: 1 }),
			'utf-8',
		)

		expect(await store.getObjective(created.id, TENANT)).toMatchObject({
			revision: 2,
			roundsStarted: 1,
		})
	})

	it('refuses a different legacy value at the immutable head revision', async () => {
		const rootDir = await mkdtemp(join(tmpdir(), 'namzu-objective-split-'))
		dirs.push(rootDir)
		const store = new DiskTopicObjectiveStore({ rootDir })
		const created = await seed(store)
		await writeFile(
			join(rootDir, 'objectives', 'obj_1.json'),
			JSON.stringify({ ...created, objective: 'written by an old binary', schemaVersion: 1 }),
			'utf-8',
		)

		await expect(store.getObjective(created.id, TENANT)).rejects.toThrow(
			/incompatible writers or damaged revision data/,
		)
	})

	it('ignores abandoned scratch files that never became a revision', async () => {
		const rootDir = await mkdtemp(join(tmpdir(), 'namzu-objective-scratch-'))
		dirs.push(rootDir)
		const revisions = join(rootDir, 'objectives', '.revisions', 'obj_1')
		await mkdir(revisions, { recursive: true })
		await writeFile(join(revisions, '1.json.123.1.deadbeef.tmp'), '{"partial":', 'utf-8')

		const created = await seed(new DiskTopicObjectiveStore({ rootDir }))

		expect(created).toMatchObject({ revision: 1, objective: 'migrate the tests' })
	})

	it('keeps a traversal-shaped objective id inside the configured root', async () => {
		const rootDir = await mkdtemp(join(tmpdir(), 'namzu-objective-path-'))
		dirs.push(rootDir)
		const escaped = `escaped-${Date.now()}`
		const id = `../../${escaped}`
		const outside = join(rootDir, '..', `${escaped}.json`)
		const store = new DiskTopicObjectiveStore({ rootDir })

		await store.createObjective(
			{ id, topicId: TOPIC, objective: 'stay under the root', maxRounds: 2 },
			TENANT,
		)

		expect(await store.getObjective(id, TENANT)).toMatchObject({ id, revision: 1 })
		await expect(access(outside)).rejects.toMatchObject({ code: 'ENOENT' })
	})
})
