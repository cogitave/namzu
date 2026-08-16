import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { TenantId, TopicId } from '../../types/ids/index.js'
import {
	type ObjectivePhase,
	type ObjectiveRoundVerdict,
	StaleObjectiveError,
	type TopicObjective,
} from '../../types/topic/objective.js'
import { DiskRecordStore } from '../kv/record-store.js'
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
const records = new DiskRecordStore<TopicObjective>(SCHEMA)

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

	abstract getObjective(id: string, tenantId: TenantId): Promise<TopicObjective | null>
	protected abstract put(record: TopicObjective): Promise<void>

	async createObjective(
		params: CreateObjectiveParams,
		tenantId: TenantId,
	): Promise<TopicObjective> {
		if (await this.getObjective(params.id, tenantId)) {
			throw new ObjectiveExistsError({ id: params.id })
		}
		if (params.maxRounds < 1) {
			// A cap of zero is an objective that can never run. Accepting it
			// would produce a record that blocks on its own first round, which
			// reads as a runaway that was stopped rather than a caller mistake.
			throw new Error(`maxRounds must be at least 1, got ${params.maxRounds}.`)
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
		await this.put(record)
		return record
	}

	async beginRound(
		id: string,
		tenantId: TenantId,
		opts: { revision: number },
	): Promise<TopicObjective> {
		const existing = await this.getObjective(id, tenantId)
		if (!existing) throw missing(id)
		assertFresh(id, existing, opts.revision)
		if (existing.phase !== 'active') {
			throw new Error(`Objective ${id} is ${existing.phase}, not active.`)
		}
		if (existing.roundsStarted >= existing.maxRounds) {
			// Blocked BEFORE the throw. A caller that swallows this error, or a
			// process that dies on it, must not leave a record that still says
			// `active` — the next reader would start the round this refused.
			await this.put({
				...existing,
				revision: existing.revision + 1,
				phase: 'blocked',
				blockedReason: {
					code: 'round_cap',
					message: `Reached the ${existing.maxRounds}-round cap.`,
				},
				updatedAt: this.now(),
			})
			throw new ObjectiveExhaustedError({ id, maxRounds: existing.maxRounds })
		}
		const record: TopicObjective = {
			...existing,
			revision: existing.revision + 1,
			roundsStarted: existing.roundsStarted + 1,
			updatedAt: this.now(),
		}
		await this.put(record)
		return record
	}

	async settleRound(
		id: string,
		tenantId: TenantId,
		verdict: ObjectiveRoundVerdict,
		opts: { revision: number },
	): Promise<TopicObjective> {
		const existing = await this.getObjective(id, tenantId)
		if (!existing) throw missing(id)
		assertFresh(id, existing, opts.revision)
		const record: TopicObjective = {
			...existing,
			revision: existing.revision + 1,
			phase: verdict.phase ?? existing.phase,
			...(verdict.blockedReason ? { blockedReason: verdict.blockedReason } : {}),
			...(verdict.runId ? { lastRunId: verdict.runId } : {}),
			updatedAt: this.now(),
		}
		await this.put(record)
		return record
	}

	async setPhase(
		id: string,
		tenantId: TenantId,
		phase: ObjectivePhase,
		opts: { revision: number },
	): Promise<TopicObjective> {
		const existing = await this.getObjective(id, tenantId)
		if (!existing) throw missing(id)
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
		await this.put(record)
		return record
	}
}

export class InMemoryTopicObjectiveStore extends ObjectiveStoreBase {
	private readonly objectives = new Map<string, TopicObjective>()

	constructor(now: () => number = Date.now) {
		super(now)
	}

	async getObjective(id: string, tenantId: TenantId): Promise<TopicObjective | null> {
		const found = this.objectives.get(id)
		// Another tenant's record reads as absent rather than as an error, for
		// the reason the project listing gives: refusing confirms it is there.
		return found && found.tenantId === tenantId ? found : null
	}

	protected async put(record: TopicObjective): Promise<void> {
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
	}

	private path(id: string): string {
		return join(this.config.rootDir, 'objectives', `${id}.json`)
	}

	async getObjective(id: string, tenantId: TenantId): Promise<TopicObjective | null> {
		const found = await records.read(this.path(id))
		return found && found.tenantId === tenantId ? found : null
	}

	protected async put(record: TopicObjective): Promise<void> {
		await mkdir(join(this.config.rootDir, 'objectives'), { recursive: true })
		await records.write(this.path(record.id), record)
	}
}
