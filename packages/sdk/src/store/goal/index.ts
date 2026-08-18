import { join } from 'node:path'

import { TenantIsolationError } from '../../session/errors.js'
import type { GoalBlockReason, GoalPhase, GoalRef, SessionGoal } from '../../types/goal/index.js'
import type { GoalId, SessionId, TenantId } from '../../types/ids/index.js'
import type { SessionStore } from '../../types/session/store.js'
import { asGoalId, asSessionId, generateGoalId } from '../../utils/id.js'
import {
	DiskRevisionRecordStore,
	type RevisionMutation,
	type RevisionedRecordLocation,
	revisionFileSegment,
} from '../kv/revision-record-store.js'
import { defineSchema } from '../schema.js'

/** Current source-backed limit for a human goal objective. */
export const MAX_GOAL_OBJECTIVE_CHARS = 4_000

export interface CreateSessionGoalParams {
	readonly sessionId: SessionId
	readonly objective: string
}

export interface EditSessionGoalParams {
	readonly objective: string
}

export interface SessionGoalStore {
	getGoal(sessionId: SessionId, tenantId: TenantId): Promise<SessionGoal | null>
	createGoal(params: CreateSessionGoalParams, tenantId: TenantId): Promise<SessionGoal>
	editGoal(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		changes: EditSessionGoalParams,
	): Promise<SessionGoal>
	pauseGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<SessionGoal>
	resumeGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<SessionGoal>
	completeGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<SessionGoal>
	blockGoal(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		reason: GoalBlockReason,
	): Promise<SessionGoal>
	clearGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<void>
}

/** A mutation was based on a goal revision that is no longer current. */
export class StaleGoalError extends Error {
	readonly details: {
		readonly sessionId: SessionId
		readonly expectedRevision: number
		readonly actualRevision: number
	}

	constructor(details: StaleGoalError['details']) {
		super(
			`Stale goal for ${details.sessionId}: expected revision=${details.expectedRevision}, actual=${details.actualRevision}.`,
		)
		this.name = 'StaleGoalError'
		this.details = details
	}
}

/** A session already has a goal that has not completed or been cleared. */
export class GoalExistsError extends Error {
	constructor(readonly goal: SessionGoal) {
		super(`Session ${goal.sessionId} already has an ${goal.phase} goal.`)
		this.name = 'GoalExistsError'
	}
}

/** A goal operation was requested for a session with no current goal. */
export class GoalNotFoundError extends Error {
	constructor(readonly sessionId: SessionId) {
		super(`Session ${sessionId} has no current goal.`)
		this.name = 'GoalNotFoundError'
	}
}

/** A goal transition is invalid from its current durable phase. */
export class GoalTransitionError extends Error {
	constructor(
		readonly phase: GoalPhase,
		readonly operation: string,
	) {
		super(`Cannot ${operation} a goal whose phase is ${phase}.`)
		this.name = 'GoalTransitionError'
	}
}

/** Goal storage refuses ids that do not name a live tenant-owned Session. */
export class GoalSessionNotFoundError extends Error {
	constructor(readonly sessionId: SessionId) {
		super(`Cannot use a goal for ${sessionId}: that session does not exist.`)
		this.name = 'GoalSessionNotFoundError'
	}
}

interface SessionGoalRecord {
	readonly sessionId: SessionId
	readonly tenantId: TenantId
	/** Storage sequence survives clear and fresh goal identities. */
	readonly storageRevision: number
	readonly goal: SessionGoal | null
	readonly updatedAt: number
}

const SCHEMA = defineSchema({
	kind: 'session-goal',
	current: 1,
	migrations: {},
})
const revisionRecords = new DiskRevisionRecordStore<SessionGoalRecord>(
	SCHEMA,
	'session goal store',
	(record) => record.storageRevision,
)

interface GoalBackend {
	readonly read: (sessionId: SessionId) => Promise<SessionGoalRecord | null>
	readonly transact: <R>(
		sessionId: SessionId,
		mutate: (current: SessionGoalRecord | null) => RevisionMutation<SessionGoalRecord, R>,
	) => Promise<R>
}

const backends = new WeakMap<object, GoalBackend>()

function backendFor(store: object): GoalBackend {
	const backend = backends.get(store)
	if (!backend) throw new Error('Session goal store backend was not initialized.')
	return backend
}

function validSessionId(value: SessionId): SessionId {
	if (typeof value !== 'string') throw new TypeError('sessionId must be a string.')
	return asSessionId(value)
}

function validRef(ref: GoalRef): GoalRef {
	if (typeof ref.id !== 'string') throw new TypeError('goal id must be a string.')
	const id = asGoalId(ref.id)
	if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) {
		throw new TypeError(`goal revision must be a positive safe integer, got ${ref.revision}.`)
	}
	return { id, revision: ref.revision }
}

function objective(value: string): string {
	if (typeof value !== 'string') throw new TypeError('goal objective must be a string.')
	const trimmed = value.trim()
	if (trimmed.length === 0) throw new TypeError('goal objective must not be empty.')
	if ([...trimmed].length > MAX_GOAL_OBJECTIVE_CHARS) {
		throw new TypeError(`goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters.`)
	}
	return trimmed
}

function blockReason(value: GoalBlockReason): GoalBlockReason {
	if (
		typeof value?.code !== 'string' ||
		!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value.code) ||
		typeof value?.message !== 'string' ||
		value.message.trim().length === 0
	) {
		throw new TypeError(
			'goal block reason requires a lower-kebab-case code and a non-empty message.',
		)
	}
	return { code: value.code, message: value.message.trim() }
}

function assertTenant(record: SessionGoalRecord, tenantId: TenantId): void {
	if (record.tenantId !== tenantId) {
		throw new TenantIsolationError({
			requested: tenantId,
			resource: `session-goal(${record.sessionId})`,
		})
	}
}

function currentGoal(
	record: SessionGoalRecord | null,
	sessionId: SessionId,
	tenantId: TenantId,
	ref: GoalRef,
): SessionGoal {
	if (!record) throw new GoalNotFoundError(sessionId)
	assertTenant(record, tenantId)
	if (record.sessionId !== sessionId) throw new Error('Session goal storage key mismatch.')
	const goal = record.goal
	if (!goal) throw new GoalNotFoundError(sessionId)
	if (goal.id !== ref.id || goal.revision !== ref.revision) {
		throw new StaleGoalError({
			sessionId,
			expectedRevision: ref.revision,
			actualRevision: goal.revision,
		})
	}
	return goal
}

abstract class SessionGoalStoreBase implements SessionGoalStore {
	protected constructor(
		protected readonly sessions: Pick<SessionStore, 'getSession'>,
		protected readonly now: () => number,
		protected readonly makeGoalId: () => GoalId,
	) {}

	protected abstract put(record: SessionGoalRecord): Promise<void>

	private async requireSession(sessionId: SessionId, tenantId: TenantId): Promise<SessionId> {
		const checked = validSessionId(sessionId)
		if (!(await this.sessions.getSession(checked, tenantId))) {
			throw new GoalSessionNotFoundError(checked)
		}
		return checked
	}

	async getGoal(sessionId: SessionId, tenantId: TenantId): Promise<SessionGoal | null> {
		const checked = await this.requireSession(sessionId, tenantId)
		const record = await backendFor(this).read(checked)
		if (!record) return null
		assertTenant(record, tenantId)
		if (record.sessionId !== checked) throw new Error('Session goal storage key mismatch.')
		return record.goal
	}

	async createGoal(params: CreateSessionGoalParams, tenantId: TenantId): Promise<SessionGoal> {
		const sessionId = await this.requireSession(params.sessionId, tenantId)
		const text = objective(params.objective)
		return await backendFor(this).transact(sessionId, (existing) => {
			if (existing) {
				assertTenant(existing, tenantId)
				if (existing.goal && existing.goal.phase !== 'complete') {
					throw new GoalExistsError(existing.goal)
				}
			}
			const now = this.now()
			const goal: SessionGoal = {
				id: this.makeGoalId(),
				sessionId,
				tenantId,
				revision: 1,
				objective: text,
				phase: 'active',
				createdAt: now,
				updatedAt: now,
			}
			const record: SessionGoalRecord = {
				sessionId,
				tenantId,
				storageRevision: (existing?.storageRevision ?? 0) + 1,
				goal,
				updatedAt: now,
			}
			return { record, result: goal }
		})
	}

	async editGoal(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		changes: EditSessionGoalParams,
	): Promise<SessionGoal> {
		const checked = await this.requireSession(sessionId, tenantId)
		const expected = validRef(ref)
		const nextObjective = objective(changes.objective)
		return await this.mutate(checked, tenantId, expected, (goal) => {
			if (goal.phase === 'complete') throw new GoalTransitionError(goal.phase, 'edit')
			return {
				...goal,
				objective: nextObjective,
			}
		})
	}

	async pauseGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<SessionGoal> {
		return await this.transition(sessionId, tenantId, ref, 'pause', ['active'], 'paused')
	}

	async resumeGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<SessionGoal> {
		return await this.transition(
			sessionId,
			tenantId,
			ref,
			'resume',
			['paused', 'blocked'],
			'active',
		)
	}

	async completeGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<SessionGoal> {
		return await this.transition(
			sessionId,
			tenantId,
			ref,
			'complete',
			['active', 'paused', 'blocked'],
			'complete',
		)
	}

	async blockGoal(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		reason: GoalBlockReason,
	): Promise<SessionGoal> {
		const validated = blockReason(reason)
		const checked = await this.requireSession(sessionId, tenantId)
		const expected = validRef(ref)
		return await this.mutate(checked, tenantId, expected, (goal) => {
			if (goal.phase !== 'active') throw new GoalTransitionError(goal.phase, 'block')
			return { ...goal, phase: 'blocked', blockedReason: validated }
		})
	}

	async clearGoal(sessionId: SessionId, tenantId: TenantId, ref: GoalRef): Promise<void> {
		const checked = await this.requireSession(sessionId, tenantId)
		const expected = validRef(ref)
		await backendFor(this).transact(checked, (existing) => {
			currentGoal(existing, checked, tenantId, expected)
			const now = this.now()
			return {
				record: {
					sessionId: checked,
					tenantId,
					storageRevision: (existing?.storageRevision ?? 0) + 1,
					goal: null,
					updatedAt: now,
				},
				result: undefined,
			}
		})
	}

	private async transition(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		operation: string,
		from: readonly GoalPhase[],
		to: GoalPhase,
	): Promise<SessionGoal> {
		const checked = await this.requireSession(sessionId, tenantId)
		const expected = validRef(ref)
		return await this.mutate(checked, tenantId, expected, (goal) => {
			if (!from.includes(goal.phase)) throw new GoalTransitionError(goal.phase, operation)
			const { blockedReason: _blockedReason, ...rest } = goal
			return { ...rest, phase: to }
		})
	}

	private async mutate(
		sessionId: SessionId,
		tenantId: TenantId,
		ref: GoalRef,
		change: (goal: SessionGoal) => Omit<SessionGoal, 'revision' | 'updatedAt'>,
	): Promise<SessionGoal> {
		return await backendFor(this).transact(sessionId, (existing) => {
			const goal = currentGoal(existing, sessionId, tenantId, ref)
			const now = this.now()
			const updated: SessionGoal = {
				...change(goal),
				revision: goal.revision + 1,
				updatedAt: now,
			}
			return {
				record: {
					sessionId,
					tenantId,
					storageRevision: (existing?.storageRevision ?? 0) + 1,
					goal: updated,
					updatedAt: now,
				},
				result: updated,
			}
		})
	}
}

export interface InMemorySessionGoalStoreConfig {
	readonly sessions: Pick<SessionStore, 'getSession'>
}

export class InMemorySessionGoalStore extends SessionGoalStoreBase {
	private readonly records = new Map<SessionId, SessionGoalRecord>()

	constructor(
		config: InMemorySessionGoalStoreConfig,
		now: () => number = Date.now,
		makeGoalId: () => GoalId = generateGoalId,
	) {
		super(config.sessions, now, makeGoalId)
		backends.set(this, {
			read: async (sessionId) => this.records.get(sessionId) ?? null,
			transact: async <R>(
				sessionId: SessionId,
				mutate: (current: SessionGoalRecord | null) => RevisionMutation<SessionGoalRecord, R>,
			) => {
				const proposal = mutate(this.records.get(sessionId) ?? null)
				await this.put(proposal.record)
				return proposal.result
			},
		})
	}

	protected async put(record: SessionGoalRecord): Promise<void> {
		const existing = this.records.get(record.sessionId)
		if (existing) assertTenant(existing, record.tenantId)
		const actual = existing?.storageRevision ?? 0
		if (record.storageRevision !== actual + 1) {
			throw new StaleGoalError({
				sessionId: record.sessionId,
				expectedRevision: record.storageRevision - 1,
				actualRevision: existing?.goal?.revision ?? 0,
			})
		}
		this.records.set(record.sessionId, record)
	}
}

export interface DiskSessionGoalStoreConfig {
	/** Session root; goals live under `<rootDir>/goals/`. */
	readonly rootDir: string
	/** Authority for session existence and tenant ownership. */
	readonly sessions: Pick<SessionStore, 'getSession'>
}

export class DiskSessionGoalStore extends SessionGoalStoreBase {
	constructor(
		private readonly config: DiskSessionGoalStoreConfig,
		now: () => number = Date.now,
		makeGoalId: () => GoalId = generateGoalId,
	) {
		super(config.sessions, now, makeGoalId)
		backends.set(this, {
			read: async (sessionId) => await revisionRecords.read(this.location(sessionId)),
			transact: async <R>(
				sessionId: SessionId,
				mutate: (current: SessionGoalRecord | null) => RevisionMutation<SessionGoalRecord, R>,
			): Promise<R> => {
				const location = this.location(sessionId)
				const proposal = mutate(await revisionRecords.read(location))
				try {
					await this.put(proposal.record)
				} catch (error) {
					if (error instanceof StaleGoalError) mutate(await revisionRecords.read(location))
					throw error
				}
				return proposal.result
			},
		})
	}

	private location(sessionId: SessionId): RevisionedRecordLocation {
		const root = join(this.config.rootDir, 'goals')
		const segment = revisionFileSegment(sessionId)
		return {
			legacyPath: join(root, `${segment}.json`),
			revisionsDir: join(root, '.revisions', segment),
		}
	}

	protected async put(record: SessionGoalRecord): Promise<void> {
		await revisionRecords.transact(this.location(record.sessionId), (existing) => {
			if (existing) assertTenant(existing, record.tenantId)
			const actual = existing?.storageRevision ?? 0
			if (record.storageRevision !== actual + 1) {
				throw new StaleGoalError({
					sessionId: record.sessionId,
					expectedRevision: record.storageRevision - 1,
					actualRevision: existing?.goal?.revision ?? 0,
				})
			}
			return { record, result: undefined }
		})
	}
}
