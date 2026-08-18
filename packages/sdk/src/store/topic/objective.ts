import { join } from 'node:path'

import { TenantIsolationError } from '../../session/errors.js'
import type { TenantId, TopicId } from '../../types/ids/index.js'
import {
	type ObjectivePhase,
	type ObjectiveRoundVerdict,
	StaleObjectiveError,
	type TopicObjective,
} from '../../types/topic/objective.js'
import {
	DiskRevisionRecordStore,
	type RevisionMutation,
	type RevisionedRecordLocation,
	legacyRevisionFileSegment,
	revisionFileSegment,
} from '../kv/revision-record-store.js'
import { defineSchema } from '../schema.js'

/**
 * Where an objective lives between runs.
 *
 * Beside `TopicStateStore` rather than inside it, for the reason that store
 * gives for living beside the Topic: permission mode and the next-run queue
 * change several times inside one conversation, and an objective's phase
 * changes once per round. Sharing a `revision` would make a round
 * completing conflict with a mode toggle — two facts about one topic that
 * have nothing to say to each other.
 */

const SCHEMA = defineSchema({ kind: 'topic-objective', current: 1, migrations: {} })
const revisionRecords = new DiskRevisionRecordStore<TopicObjective>(SCHEMA, 'topic objective store')

export interface CreateObjectiveParams {
	readonly id: string
	readonly topicId: TopicId
	readonly objective: string
	/** Rounds this objective may BEGIN before it blocks itself. */
	readonly maxRounds: number
}

export interface TopicObjectiveStore {
	/** `null` when this id has never been written, or belongs to another tenant. */
	getObjective(id: string, tenantId: TenantId): Promise<TopicObjective | null>

	/**
	 * Refuses an id that already exists, rather than overwriting.
	 *
	 * A create that silently replaced would reset `roundsStarted` — the one
	 * field whose whole job is to be un-resettable by the thing it caps.
	 */
	createObjective(params: CreateObjectiveParams, tenantId: TenantId): Promise<TopicObjective>

	/**
	 * Debit one round, under compare-and-set on `revision`.
	 *
	 * Returns the record with `roundsStarted` already incremented, so the
	 * caller cannot run the round and then fail to record that it did.
	 * Throws `ObjectiveExhaustedError` when the cap is reached, having first
	 * written the `blocked` phase — so a reader that never sees the throw
	 * still finds the objective stopped for a stated reason.
	 */
	beginRound(id: string, tenantId: TenantId, opts: { revision: number }): Promise<TopicObjective>

	/** Record what a round decided, under the same compare-and-set. */
	settleRound(
		id: string,
		tenantId: TenantId,
		verdict: ObjectiveRoundVerdict,
		opts: { revision: number },
	): Promise<TopicObjective>

	/** Move between `active` and `paused`, under the same compare-and-set. */
	setPhase(
		id: string,
		tenantId: TenantId,
		phase: ObjectivePhase,
		opts: { revision: number },
	): Promise<TopicObjective>
}

/** A round asked for beyond the cap. */
export class ObjectiveExhaustedError extends Error {
	readonly details: { id: string; maxRounds: number }

	constructor(details: { id: string; maxRounds: number }) {
		super(`Objective ${details.id} has used all ${details.maxRounds} of its rounds.`)
		this.name = 'ObjectiveExhaustedError'
		this.details = details
	}
}

/** An id that already exists. */
export class ObjectiveExistsError extends Error {
	readonly details: { id: string }

	constructor(details: { id: string }) {
		super(`Objective ${details.id} already exists.`)
		this.name = 'ObjectiveExistsError'
		this.details = details
	}
}

function assertFresh(id: string, existing: TopicObjective, revision: number): void {
	if (revision !== existing.revision) {
		throw new StaleObjectiveError({
			id,
			expectedRevision: revision,
			actualRevision: existing.revision,
		})
	}
}

function missing(id: string): Error {
	return new Error(`No objective ${id}.`)
}

function assertTenant(record: TopicObjective, tenantId: TenantId): void {
	if (record.tenantId !== tenantId) {
		throw new TenantIsolationError({ requested: tenantId, resource: `objective(${record.id})` })
	}
}

interface ObjectiveBackend {
	readonly read: (id: string) => Promise<TopicObjective | null>
	readonly transact: <R>(
		id: string,
		mutate: (current: TopicObjective | null) => RevisionMutation<TopicObjective, R>,
	) => Promise<R>
}

const objectiveBackends = new WeakMap<object, ObjectiveBackend>()

function backendFor(store: object): ObjectiveBackend {
	const backend = objectiveBackends.get(store)
	if (!backend) throw new Error('Objective store backend was not initialized.')
	return backend
}

/**
 * The shared write logic.
 *
 * Both implementations differ only in where the record lands, so the rules
 * — what a round costs, when the cap bites, which phases accept a write —
 * are written once. Two copies of a compare-and-set is two chances to have
 * one of them drift, and the drift would be invisible until a host used the
 * other implementation.
 */
abstract class ObjectiveStoreBase implements TopicObjectiveStore {
	protected constructor(protected readonly now: () => number) {}

	/**
	 * Commit seam for the shared domain transitions. Shipped implementations
	 * enforce an exact next revision here; keeping every transition on this
	 * path also preserves a subclass observer without letting it replace the
	 * domain rules above.
	 */
	protected abstract put(record: TopicObjective): Promise<void>

	async getObjective(id: string, tenantId: TenantId): Promise<TopicObjective | null> {
		const found = await backendFor(this).read(id)
		// Enumeration-style reads deliberately hide another tenant's record.
		// Mutations reject instead: treating it as absent would overwrite it.
		return found && found.tenantId === tenantId ? found : null
	}

	async createObjective(
		params: CreateObjectiveParams,
		tenantId: TenantId,
	): Promise<TopicObjective> {
		if (!Number.isSafeInteger(params.maxRounds) || params.maxRounds < 1) {
			// A cap of zero is an objective that can never run. Accepting it
			// would produce a record that blocks on its own first round, which
			// reads as a runaway that was stopped rather than a caller mistake.
			throw new Error(`maxRounds must be a positive safe integer, got ${params.maxRounds}.`)
		}
		return await backendFor(this).transact(params.id, (existing) => {
			if (existing) {
				assertTenant(existing, tenantId)
				throw new ObjectiveExistsError({ id: params.id })
			}
			const record: TopicObjective = {
				id: params.id,
				topicId: params.topicId,
				tenantId,
				revision: 1,
				objective: params.objective,
				phase: 'active',
				maxRounds: params.maxRounds,
				roundsStarted: 0,
				updatedAt: this.now(),
			}
			return { record, result: record }
		})
	}

	async beginRound(
		id: string,
		tenantId: TenantId,
		opts: { revision: number },
	): Promise<TopicObjective> {
		const outcome = await backendFor(this).transact<{
			record: TopicObjective
			exhausted: boolean
		}>(id, (existing) => {
			if (!existing) throw missing(id)
			assertTenant(existing, tenantId)
			assertFresh(id, existing, opts.revision)
			if (existing.phase !== 'active') {
				throw new Error(`Objective ${id} is ${existing.phase}, not active.`)
			}
			if (existing.roundsStarted >= existing.maxRounds) {
				const record: TopicObjective = {
					...existing,
					revision: existing.revision + 1,
					phase: 'blocked',
					blockedReason: {
						code: 'round_cap',
						message: `Reached the ${existing.maxRounds}-round cap.`,
					},
					updatedAt: this.now(),
				}
				return { record, result: { record, exhausted: true as const } }
			}
			const record: TopicObjective = {
				...existing,
				revision: existing.revision + 1,
				roundsStarted: existing.roundsStarted + 1,
				updatedAt: this.now(),
			}
			return { record, result: { record, exhausted: false as const } }
		})
		if (outcome.exhausted) {
			// Blocked BEFORE the throw. The committed result is what a reader sees
			// even if this exception is swallowed or the caller exits on it.
			throw new ObjectiveExhaustedError({ id, maxRounds: outcome.record.maxRounds })
		}
		return outcome.record
	}

	async settleRound(
		id: string,
		tenantId: TenantId,
		verdict: ObjectiveRoundVerdict,
		opts: { revision: number },
	): Promise<TopicObjective> {
		return await backendFor(this).transact(id, (existing) => {
			if (!existing) throw missing(id)
			assertTenant(existing, tenantId)
			assertFresh(id, existing, opts.revision)
			const record: TopicObjective = {
				...existing,
				revision: existing.revision + 1,
				phase: verdict.phase ?? existing.phase,
				...(verdict.blockedReason ? { blockedReason: verdict.blockedReason } : {}),
				...(verdict.runId ? { lastRunId: verdict.runId } : {}),
				updatedAt: this.now(),
			}
			return { record, result: record }
		})
	}

	async setPhase(
		id: string,
		tenantId: TenantId,
		phase: ObjectivePhase,
		opts: { revision: number },
	): Promise<TopicObjective> {
		return await backendFor(this).transact(id, (existing) => {
			if (!existing) throw missing(id)
			assertTenant(existing, tenantId)
			assertFresh(id, existing, opts.revision)
			if (existing.phase === 'complete' && phase !== 'complete') {
				// One-way. Reopening a finished objective by writing a phase would
				// let a stale caller restart work somebody already signed off, and
				// the round counter it would run against is the one already spent.
				throw new Error(`Objective ${id} is complete; it cannot be moved to ${phase}.`)
			}
			// A move off `blocked` drops the reason. Carrying it would describe a
			// running objective as blocked by something it no longer is, and that
			// stale sentence is what an operator reads to decide whether to
			// intervene.
			const { blockedReason, ...rest } = existing
			const record: TopicObjective = {
				...rest,
				revision: existing.revision + 1,
				phase,
				...(phase === 'blocked' && blockedReason ? { blockedReason } : {}),
				updatedAt: this.now(),
			}
			return { record, result: record }
		})
	}
}

export class InMemoryTopicObjectiveStore extends ObjectiveStoreBase {
	private readonly objectives = new Map<string, TopicObjective>()

	constructor(now: () => number = Date.now) {
		super(now)
		objectiveBackends.set(this, {
			read: async (id) => this.objectives.get(id) ?? null,
			transact: async <R>(
				id: string,
				mutate: (current: TopicObjective | null) => RevisionMutation<TopicObjective, R>,
			): Promise<R> => {
				// Deliberately no await: read, domain checks and publish are one JS
				// turn. `put` executes its map check/set before its returned promise
				// settles; awaiting an async get before this point would let two callers
				// capture the same revision.
				const proposal = mutate(this.objectives.get(id) ?? null)
				await this.put(proposal.record)
				return proposal.result
			},
		})
	}

	protected async put(record: TopicObjective): Promise<void> {
		const existing = this.objectives.get(record.id)
		if (existing) assertTenant(existing, record.tenantId)
		const expected = (existing?.revision ?? 0) + 1
		if (record.revision !== expected) {
			throw new StaleObjectiveError({
				id: record.id,
				expectedRevision: record.revision - 1,
				actualRevision: existing?.revision ?? 0,
			})
		}
		this.objectives.set(record.id, record)
	}
}

export interface DiskTopicObjectiveStoreConfig {
	/** The session root. Objectives live under `<rootDir>/objectives/`. */
	readonly rootDir: string
}

export class DiskTopicObjectiveStore extends ObjectiveStoreBase {
	constructor(
		private readonly config: DiskTopicObjectiveStoreConfig,
		now: () => number = Date.now,
	) {
		super(now)
		objectiveBackends.set(this, {
			read: async (id) => await revisionRecords.read(this.location(id)),
			transact: async <R>(
				id: string,
				mutate: (current: TopicObjective | null) => RevisionMutation<TopicObjective, R>,
			): Promise<R> => {
				const location = this.location(id)
				const proposal = mutate(await revisionRecords.read(location))
				try {
					await this.put(proposal.record)
				} catch (err) {
					if (err instanceof StaleObjectiveError) {
						// Re-run only the domain guard against the durable winner. Creation
						// must report ObjectiveExistsError, while an ordinary mutation keeps
						// the stale error and its actual revision.
						mutate(await revisionRecords.read(location))
					}
					throw err
				}
				return proposal.result
			},
		})
	}

	private location(id: string): RevisionedRecordLocation {
		const root = join(this.config.rootDir, 'objectives')
		const segment = revisionFileSegment(id)
		return {
			legacyPath: join(root, `${legacyRevisionFileSegment(id)}.json`),
			revisionsDir: join(root, '.revisions', segment),
		}
	}

	protected async put(record: TopicObjective): Promise<void> {
		await revisionRecords.transact(this.location(record.id), (existing) => {
			if (existing) assertTenant(existing, record.tenantId)
			const actual = existing?.revision ?? 0
			if (record.revision !== actual + 1) {
				throw new StaleObjectiveError({
					id: record.id,
					expectedRevision: record.revision - 1,
					actualRevision: actual,
				})
			}
			return { record, result: undefined }
		})
	}
}
