import { createHash, randomUUID } from 'node:crypto'
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ProjectId, TenantId } from '../../types/ids/index.js'
import { asProjectId, asTenantId } from '../../utils/id.js'
import {
	type ResidentLearningCycleEvent,
	type ResidentLearningCycleOptions,
	type ResidentLearningCycleResult,
	runResidentLearningCycle,
} from './learning-cycle.js'
import {
	type ResidentLearningObservation,
	type ResidentLearningObservationRecord,
	type ResidentLearningTarget,
	learningObservationSchema,
	learningTargetSchema,
} from './learning-observation.js'
import { hashResidentSkill } from './learning.js'

const uuid = z
	.string()
	.uuid()
	.transform((id) => id.toLowerCase())
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const MAX_EVENT_BYTES = 256 * 1024
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
const MAX_EVENTS = 4096
const MAX_ARTIFACTS = 256
const NO_LATER_PASS = `NOT EXISTS (
  SELECT 1 FROM observations newer WHERE newer.tenant_id=o.tenant_id
  AND newer.project_id=o.project_id AND newer.agent_key=o.agent_key
  AND newer.skill_name=o.skill_name AND newer.evaluator_revision=o.evaluator_revision
  AND newer.baseline_revision=o.baseline_revision AND newer.task_key=o.task_key
  AND newer.ordinal>o.ordinal AND json_extract(newer.body, '$.outcome')='passed'
)`
const OBSERVATIONS_SCHEMA = `
CREATE TABLE observations (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, agent_key TEXT NOT NULL,
  session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  evaluator_revision TEXT NOT NULL, skill_name TEXT NOT NULL,
  baseline_revision TEXT NOT NULL, task_key TEXT NOT NULL,
  eligible INTEGER NOT NULL, body TEXT NOT NULL,
  UNIQUE(tenant_id, project_id, agent_key, session_id, turn_id, evaluator_revision, skill_name)
);
CREATE INDEX observations_select ON observations(
  tenant_id, project_id, agent_key, skill_name, evaluator_revision, baseline_revision, eligible, ordinal
);
CREATE INDEX observations_task ON observations(
  tenant_id, project_id, agent_key, skill_name, evaluator_revision, baseline_revision, task_key, ordinal
);
CREATE TABLE observation_attempts (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, agent_key TEXT NOT NULL,
  skill_name TEXT NOT NULL, evaluator_revision TEXT NOT NULL,
  baseline_revision TEXT NOT NULL, task_key TEXT NOT NULL,
  cycle_id TEXT NOT NULL REFERENCES cycles(id),
  PRIMARY KEY(tenant_id, project_id, agent_key, skill_name, evaluator_revision, baseline_revision, task_key)
);
`
const SCHEMA = `
CREATE TABLE cycles (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, agent_key TEXT NOT NULL,
  parent_id TEXT, skill_name TEXT, status TEXT NOT NULL,
  sequence INTEGER NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  candidate_hash TEXT, result TEXT,
  tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  receipts INTEGER NOT NULL DEFAULT 0, unknown_tokens INTEGER NOT NULL DEFAULT 0,
  unknown_costs INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX cycles_scope ON cycles(tenant_id, project_id, agent_key, ordinal);
CREATE TABLE events (
  cycle_id TEXT NOT NULL REFERENCES cycles(id), sequence INTEGER NOT NULL,
  body TEXT NOT NULL, PRIMARY KEY(cycle_id, sequence)
);
CREATE TABLE artifacts (
  cycle_id TEXT NOT NULL REFERENCES cycles(id), name TEXT NOT NULL, hash TEXT NOT NULL,
  bytes INTEGER NOT NULL, PRIMARY KEY(cycle_id, name)
);
CREATE TABLE usage_receipts (
  cycle_id TEXT NOT NULL REFERENCES cycles(id),
  session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  PRIMARY KEY(cycle_id, turn_id)
);
`

/**
 * The schema this store writes and reads. Versions 1 and 2 keyed observations
 * and receipts by a run id; a database at either (or any other version) is
 * refused, never migrated — its rows name executions that no longer exist.
 */
export const RESIDENT_LEARNING_STORE_VERSION = 3

/** A learning database this version of the store does not read. */
export class ResidentLearningStoreVersionError extends Error {
	override readonly name = 'ResidentLearningStoreVersionError'
	readonly found: number
	readonly expected: number

	constructor(databasePath: string, found: number) {
		super(
			`Learning database ${databasePath} is at schema version ${found}; this store reads version ${RESIDENT_LEARNING_STORE_VERSION} only. Databases before version 3 are not read: move the file aside and start a new learning database.`,
		)
		this.found = found
		this.expected = RESIDENT_LEARNING_STORE_VERSION
	}
}

/** @experimental Private parent directories and backup policy remain host responsibilities. */
export interface SqliteResidentLearningStoreOptions {
	readonly databasePath: string
	readonly artifactsPath: string
	readonly scope: {
		readonly tenantId: TenantId
		readonly projectId: ProjectId
		readonly agentKey: string
	}
	readonly readOnly?: boolean
}

/** @experimental A content-addressed immutable JSON artifact, scoped through its owning cycle. */
export interface ResidentLearningArtifact {
	readonly name: string
	readonly hash: string
	readonly bytes: number
}

/** @experimental Recorded lower bounds; absence of a final result means completeness is unknown. */
export interface ResidentLearningRecordedUsage {
	readonly tokens: number
	readonly costUsd: number
	readonly receipts: number
	readonly unknownTokens: number
	readonly unknownCosts: number
}

/** @experimental Running/pending records require inspection; neither implies a live executor. */
export interface ResidentLearningCycleSummary {
	readonly cycleId: string
	readonly ordinal: number
	readonly parentCycleId: string | null
	readonly skillName: string | null
	readonly status: ResidentLearningCycleResult['status'] | 'running' | 'activation-pending'
	readonly sequence: number
	readonly startedAt: number
	readonly updatedAt: number
	readonly candidateRevision: string | null
	readonly result: ResidentLearningCycleResult | null
	readonly recordedUsage: ResidentLearningRecordedUsage
}

type CycleRow = {
	id: string
	ordinal: number
	tenant_id: string
	project_id: string
	agent_key: string
	parent_id: string | null
	skill_name: string | null
	status: ResidentLearningCycleSummary['status']
	sequence: number
	started_at: number
	updated_at: number
	candidate_hash: string | null
	result: string | null
	tokens: number
	cost_usd: number
	receipts: number
	unknown_tokens: number
	unknown_costs: number
}

const summary = (row: CycleRow): ResidentLearningCycleSummary => ({
	cycleId: row.id,
	ordinal: row.ordinal,
	parentCycleId: row.parent_id,
	skillName: row.skill_name,
	status: row.status,
	sequence: row.sequence,
	startedAt: row.started_at,
	updatedAt: row.updated_at,
	candidateRevision: row.candidate_hash,
	result: row.result === null ? null : JSON.parse(row.result),
	recordedUsage: {
		tokens: row.tokens,
		costUsd: row.cost_usd,
		receipts: row.receipts,
		unknownTokens: row.unknown_tokens,
		unknownCosts: row.unknown_costs,
	},
})

/**
 * @experimental Authoritative experiment journal and query index in one transaction.
 * Large JSON artifacts are published completely before their SQLite references.
 * No database transaction spans an await, model request or artifact write. JSONL
 * exports are observations, never a second writable authority or a replay queue.
 */
export class SqliteResidentLearningStore {
	readonly databasePath: string
	readonly artifactsPath: string
	private readonly scope: SqliteResidentLearningStoreOptions['scope']
	private readonly readOnly: boolean

	constructor(options: SqliteResidentLearningStoreOptions) {
		this.databasePath = resolve(options.databasePath)
		this.artifactsPath = resolve(options.artifactsPath)
		this.scope = Object.freeze({
			tenantId: asTenantId(options.scope.tenantId.toLowerCase()),
			projectId: asProjectId(options.scope.projectId.toLowerCase()),
			agentKey: z
				.string()
				.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
				.parse(options.scope.agentKey),
		})
		this.readOnly = options.readOnly === true
	}

	private use<T>(write: boolean, operation: (db: DatabaseSync) => T): T {
		if (write && this.readOnly) throw new Error('Learning database is read-only.')
		let Database: typeof DatabaseSync
		try {
			Database = (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
				.DatabaseSync
		} catch (error) {
			throw new Error('SqliteResidentLearningStore requires Node.js 22.13 or newer.', {
				cause: error,
			})
		}
		if (!this.readOnly) mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
		const db = new Database(this.databasePath, { readOnly: this.readOnly })
		try {
			db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
			if (!this.readOnly) db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;')
			db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
			try {
				const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
				if (version === 0 && write) {
					if (
						db
							.prepare(
								"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
							)
							.get()
					)
						throw new Error('Refusing to initialize a nonempty learning database.')
					db.exec(
						`${SCHEMA} ${OBSERVATIONS_SCHEMA} PRAGMA user_version = ${RESIDENT_LEARNING_STORE_VERSION};`,
					)
				} else if (version === 0)
					throw new Error('Learning database is not initialized; open it for writing first.')
				else if (version !== RESIDENT_LEARNING_STORE_VERSION)
					throw new ResidentLearningStoreVersionError(this.databasePath, version)
				const value = operation(db)
				db.exec('COMMIT')
				return value
			} catch (error) {
				db.exec('ROLLBACK')
				throw error
			}
		} finally {
			db.close()
		}
	}

	private owned(db: DatabaseSync, id: string): CycleRow | null {
		const row = db.prepare('SELECT * FROM cycles WHERE id = ?').get(id) as CycleRow | undefined
		if (!row) return null
		if (
			row.tenant_id !== this.scope.tenantId ||
			row.project_id !== this.scope.projectId ||
			row.agent_key !== this.scope.agentKey
		)
			throw new Error('Learning cycle does not belong to this tenant, project and resident.')
		return row
	}

	/** Immutable, idempotent observations. Regrading requires a different evaluator revision. */
	async observe(input: ResidentLearningObservation): Promise<void> {
		const value = learningObservationSchema.parse(input)
		const body = JSON.stringify(value)
		this.use(true, (db) => {
			const scope = [this.scope.tenantId, this.scope.projectId, this.scope.agentKey]
			const previous = db
				.prepare(
					'SELECT body FROM observations WHERE tenant_id=? AND project_id=? AND agent_key=? AND session_id=? AND turn_id=? AND evaluator_revision=? AND skill_name=?',
				)
				.get(...scope, value.sessionId, value.turnId, value.evaluatorRevision, value.skillName)
			if (previous) {
				if (previous.body !== body)
					throw new Error('Learning observation already has different content.')
				return
			}
			db.prepare(`INSERT INTO observations
				(tenant_id, project_id, agent_key, session_id, turn_id, evaluator_revision, skill_name, baseline_revision, task_key, eligible, body)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				...scope,
				value.sessionId,
				value.turnId,
				value.evaluatorRevision,
				value.skillName,
				value.baselineRevision,
				value.taskKey,
				Number(value.outcome === 'failed' && value.usageComplete),
				body,
			)
		})
	}

	private observationsQuery() {
		return `SELECT o.ordinal, o.body, a.cycle_id AS attemptedCycleId FROM observations o
			LEFT JOIN observation_attempts a ON
			a.tenant_id=o.tenant_id AND a.project_id=o.project_id AND a.agent_key=o.agent_key
			AND a.skill_name=o.skill_name AND a.evaluator_revision=o.evaluator_revision
			AND a.baseline_revision=o.baseline_revision AND a.task_key=o.task_key
			WHERE o.tenant_id=? AND o.project_id=? AND o.agent_key=?`
	}

	private observationRecord(row: {
		ordinal: number
		body: string
		attemptedCycleId: string | null
	}): ResidentLearningObservationRecord {
		const value = learningObservationSchema.parse(JSON.parse(row.body))
		return Object.freeze({
			...value,
			evidence: Object.freeze(value.evidence),
			ordinal: row.ordinal,
			attemptedCycleId: row.attemptedCycleId,
		})
	}

	/** Ordered inspection; summaries are host observations, not inferred task completion. */
	async observations(
		options: { readonly after?: number; readonly limit?: number } = {},
	): Promise<readonly ResidentLearningObservationRecord[]> {
		const after = z
			.number()
			.int()
			.nonnegative()
			.safe()
			.parse(options.after ?? 0)
		const limit = z
			.number()
			.int()
			.min(1)
			.max(100)
			.parse(options.limit ?? 20)
		if (!existsSync(this.databasePath)) return []
		return this.use(false, (db) => {
			if (Number(db.prepare('PRAGMA user_version').get()?.user_version) === 1) return []
			const rows = db
				.prepare(`${this.observationsQuery()} AND o.ordinal>? ORDER BY o.ordinal LIMIT ?`)
				.all(this.scope.tenantId, this.scope.projectId, this.scope.agentKey, after, limit)
			return rows.map((row) =>
				this.observationRecord(
					row as { ordinal: number; body: string; attemptedCycleId: string | null },
				),
			)
		})
	}

	/** Oldest eligible unattempted task across current targets; no model call or claim is made. */
	async selectObservation(
		input: readonly ResidentLearningTarget[],
	): Promise<ResidentLearningObservationRecord | null> {
		const targets = z.array(learningTargetSchema).min(1).max(16).parse(input)
		if (new Set(targets.map((t) => t.skillName)).size !== targets.length)
			throw new Error('Learning selection requires one current evaluator per skill.')
		if (!existsSync(this.databasePath)) return null
		return this.use(false, (db) => {
			if (Number(db.prepare('PRAGMA user_version').get()?.user_version) === 1) return null
			const rows = targets.flatMap((target) => {
				const row = db
					.prepare(`${this.observationsQuery()} AND o.skill_name=?
					AND o.evaluator_revision=? AND o.baseline_revision=? AND o.eligible=1
					AND a.cycle_id IS NULL AND ${NO_LATER_PASS} ORDER BY o.ordinal LIMIT 1`)
					.get(
						this.scope.tenantId,
						this.scope.projectId,
						this.scope.agentKey,
						target.skillName,
						target.evaluatorRevision,
						target.baselineRevision,
					)
				return row
					? [
							this.observationRecord(
								row as { ordinal: number; body: string; attemptedCycleId: string | null },
							),
						]
					: []
			})
			return rows.sort((a, b) => a.ordinal - b.ordinal)[0] ?? null
		})
	}

	private claimObservation(db: DatabaseSync, event: ResidentLearningCycleEvent): void {
		if (event.kind !== 'started' || event.data.observation === undefined) return
		const selected = z
			.object({ ordinal: z.number().int().positive().safe() })
			.parse(event.data.observation)
		const row = db
			.prepare(`${this.observationsQuery()} AND o.ordinal=? AND ${NO_LATER_PASS}`)
			.get(this.scope.tenantId, this.scope.projectId, this.scope.agentKey, selected.ordinal)
		if (!row) throw new Error('Selected learning observation is not retained in this scope.')
		const value = this.observationRecord(
			row as { ordinal: number; body: string; attemptedCycleId: string | null },
		)
		if (value.outcome !== 'failed' || !value.usageComplete || value.attemptedCycleId)
			throw new Error('Selected learning observation is ineligible or already attempted.')
		if (
			event.data.skillName !== value.skillName ||
			event.data.baselineRevision !== value.baselineRevision ||
			JSON.stringify(event.data.failure) !==
				JSON.stringify({ evidence: value.evidence, trace: value.trace })
		)
			throw new Error('Selected observation differs from the current learning baseline or failure.')
		db.prepare('INSERT INTO observation_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
			this.scope.tenantId,
			this.scope.projectId,
			this.scope.agentKey,
			value.skillName,
			value.evaluatorRevision,
			value.baselineRevision,
			value.taskKey,
			event.cycleId,
		)
	}

	/** Identical event retries are idempotent. Different content at the same sequence is refused. */
	async append(input: ResidentLearningCycleEvent): Promise<void> {
		const event = z
			.object({
				cycleId: uuid,
				sequence: z.number().int().min(1).max(MAX_EVENTS),
				kind: z.enum([
					'started',
					'stage-started',
					'stage-finished',
					'usage',
					'exploration',
					'candidate',
					'evaluation',
					'activation-requested',
					'finished',
				]),
				stage: z.enum(['explore', 'generate', 'verification', 'confirmation']).optional(),
				data: z.record(z.unknown()),
			})
			.parse(input)
		const body = JSON.stringify(event)
		if (Buffer.byteLength(body) > MAX_EVENT_BYTES)
			throw new Error('Learning event exceeds 256 KiB; retain large content as an artifact.')
		this.use(true, (db) => {
			let row = this.owned(db, event.cycleId)
			if (row) {
				const previous = db
					.prepare('SELECT body FROM events WHERE cycle_id = ? AND sequence = ?')
					.get(event.cycleId, event.sequence)
				if (previous) {
					if (previous.body !== body)
						throw new Error('Learning event sequence already has different content.')
					return
				}
				if (row.result !== null || event.sequence !== row.sequence + 1)
					throw new Error('Learning journal is finished or its sequence has a gap.')
			} else {
				if (event.sequence !== 1 || !['started', 'finished'].includes(event.kind))
					throw new Error(
						'Learning journal must begin with a start or a terminal preflight failure.',
					)
				if (
					event.kind === 'started' &&
					(event.data.tenantId !== this.scope.tenantId ||
						event.data.agentKey !== this.scope.agentKey)
				)
					throw new Error('Learning start does not match the bound resident.')
				const parent =
					event.data.parentCycleId === undefined ? null : uuid.parse(event.data.parentCycleId)
				if (parent && !this.owned(db, parent))
					throw new Error('Parent learning cycle is not retained in this scope.')
				const skillName =
					event.data.skillName === undefined
						? null
						: z
								.string()
								.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
								.parse(event.data.skillName)
				const now = Date.now()
				db.prepare(
					'INSERT INTO cycles (id, tenant_id, project_id, agent_key, parent_id, skill_name, status, sequence, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
				).run(
					event.cycleId,
					this.scope.tenantId,
					this.scope.projectId,
					this.scope.agentKey,
					parent,
					skillName,
					'running',
					now,
					now,
				)
				row = this.owned(db, event.cycleId) as CycleRow
			}
			this.claimObservation(db, event)
			let status = row.status
			let result: string | null = null
			let hash = row.candidate_hash
			if (event.kind === 'usage') {
				const receipt = z
					.object({
						sessionId: uuid,
						turnId: uuid,
						tokens: z.number().int().nonnegative().safe().nullable(),
						costUsd: z.number().nonnegative().finite().nullable(),
					})
					.parse(event.data.receipt)
				if (row.receipts >= 1024) throw new Error('Learning receipt bound exceeded.')
				if (
					!Number.isSafeInteger(row.tokens + (receipt.tokens ?? 0)) ||
					!Number.isFinite(row.cost_usd + (receipt.costUsd ?? 0))
				)
					throw new Error('Learning consumption overflow.')
				db.prepare(
					'INSERT INTO usage_receipts (cycle_id, session_id, turn_id) VALUES (?, ?, ?)',
				).run(event.cycleId, receipt.sessionId, receipt.turnId)
				db.prepare(
					'UPDATE cycles SET tokens = tokens + ?, cost_usd = cost_usd + ?, receipts = receipts + 1, unknown_tokens = unknown_tokens + ?, unknown_costs = unknown_costs + ? WHERE id = ?',
				).run(
					receipt.tokens ?? 0,
					receipt.costUsd ?? 0,
					Number(receipt.tokens === null),
					Number(receipt.costUsd === null),
					event.cycleId,
				)
			}
			if (event.kind === 'candidate')
				hash = z
					.string()
					.regex(/^[0-9a-f]{64}$/)
					.parse(event.data.candidateRevision)
			if (event.kind === 'activation-requested') status = 'activation-pending'
			if (event.kind === 'finished') {
				const value = event.data.result as ResidentLearningCycleResult
				if (!value || uuid.parse(value.cycleId) !== event.cycleId)
					throw new Error('Learning result identity differs from its journal.')
				status = z
					.enum([
						'activated',
						'rejected',
						'inconclusive',
						'conflict',
						'cancelled',
						'failed',
						'activation-unknown',
					])
					.parse(value.status)
				if (row.sequence === 0 && !['failed', 'cancelled'].includes(status))
					throw new Error('A successful cycle requires a recorded start.')
				const recorded = summary(row).recordedUsage
				for (const key of [
					'tokens',
					'costUsd',
					'receipts',
					'unknownTokens',
					'unknownCosts',
				] as const) {
					if (value.consumption?.[key] !== recorded[key])
						throw new Error('Final learning consumption differs from its recorded receipts.')
				}
				result = JSON.stringify(value)
			}
			db.prepare('INSERT INTO events VALUES (?, ?, ?)').run(event.cycleId, event.sequence, body)
			db.prepare(
				'UPDATE cycles SET sequence = ?, status = ?, updated_at = ?, candidate_hash = ?, result = ? WHERE id = ?',
			).run(event.sequence, status, Date.now(), hash, result, event.cycleId)
		})
	}

	async get(cycleId: string): Promise<ResidentLearningCycleSummary | null> {
		const id = uuid.parse(cycleId)
		return this.use(false, (db) => {
			const row = this.owned(db, id)
			return row ? summary(row) : null
		})
	}

	async list(
		options: { readonly before?: number; readonly limit?: number } = {},
	): Promise<readonly ResidentLearningCycleSummary[]> {
		const limit = z
			.number()
			.int()
			.min(1)
			.max(100)
			.parse(options.limit ?? 20)
		const before = z
			.number()
			.int()
			.positive()
			.safe()
			.parse(options.before ?? Number.MAX_SAFE_INTEGER)
		return this.use(false, (db) =>
			(
				db
					.prepare(
						'SELECT * FROM cycles WHERE tenant_id = ? AND project_id = ? AND agent_key = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?',
					)
					.all(
						this.scope.tenantId,
						this.scope.projectId,
						this.scope.agentKey,
						before,
						limit,
					) as CycleRow[]
			).map(summary),
		)
	}

	async events(
		cycleId: string,
		options: { readonly after?: number; readonly limit?: number } = {},
	): Promise<readonly ResidentLearningCycleEvent[]> {
		const id = uuid.parse(cycleId)
		const after = z
			.number()
			.int()
			.nonnegative()
			.max(MAX_EVENTS)
			.parse(options.after ?? 0)
		const limit = z
			.number()
			.int()
			.positive()
			.max(256)
			.parse(options.limit ?? 100)
		return this.use(false, (db) => {
			if (!this.owned(db, id)) return []
			return db
				.prepare(
					'SELECT body FROM events WHERE cycle_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
				)
				.all(id, after, limit)
				.map((row) => JSON.parse(String(row.body)))
		})
	}

	async artifacts(cycleId: string): Promise<readonly ResidentLearningArtifact[]> {
		const id = uuid.parse(cycleId)
		return this.use(false, (db) => {
			if (!this.owned(db, id)) return []
			return db
				.prepare('SELECT name, hash, bytes FROM artifacts WHERE cycle_id = ? ORDER BY name')
				.all(id) as unknown as ResidentLearningArtifact[]
		})
	}

	/** Complete immutable bytes precede the reference; an interrupted publication may leave an unreferenced blob. */
	async putArtifact(
		cycleId: string,
		name: string,
		value: unknown,
	): Promise<ResidentLearningArtifact> {
		if (this.readOnly) throw new Error('Learning database is read-only.')
		const id = uuid.parse(cycleId)
		z.string()
			.regex(/^[a-z0-9][a-z0-9_.-]{0,119}$/)
			.parse(name)
		if (!(await this.get(id))) throw new Error('Learning artifact requires a recorded cycle.')
		const body = JSON.stringify(value)
		if (body === undefined || Buffer.byteLength(body) > MAX_ARTIFACT_BYTES)
			throw new Error('Learning artifact must be JSON within 8 MiB.')
		const artifact = {
			name,
			hash: digest(body),
			bytes: Buffer.byteLength(body),
		}
		mkdirSync(this.artifactsPath, { recursive: true, mode: 0o700 })
		const target = join(this.artifactsPath, `${artifact.hash}.json`)
		const temporary = join(this.artifactsPath, `.candidate-${randomUUID()}`)
		const fd = openSync(temporary, 'wx', 0o600)
		try {
			try {
				writeFileSync(fd, body)
				fsyncSync(fd)
			} finally {
				closeSync(fd)
			}
			try {
				linkSync(temporary, target)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
			}
			const entry = lstatSync(target)
			if (
				!entry.isFile() ||
				entry.isSymbolicLink() ||
				entry.size !== artifact.bytes ||
				digest(readFileSync(target)) !== artifact.hash
			)
				throw new Error('Learning artifact content does not match its hash.')
		} finally {
			unlinkSync(temporary)
		}
		// Directory sync makes the filename durable before the database reference.
		if (process.platform !== 'win32') {
			const directory = openSync(this.artifactsPath, 'r')
			try {
				fsyncSync(directory)
			} finally {
				closeSync(directory)
			}
		}
		this.use(true, (db) => {
			if (!this.owned(db, id)) throw new Error('Learning cycle disappeared.')
			const previous = db
				.prepare('SELECT hash FROM artifacts WHERE cycle_id = ? AND name = ?')
				.get(id, name)
			if (previous) {
				if (previous.hash !== artifact.hash)
					throw new Error('Learning artifact name already identifies different content.')
				return
			}
			if (
				Number(
					db.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE cycle_id = ?').get(id)?.count,
				) >= MAX_ARTIFACTS
			)
				throw new Error('Learning cycle artifact bound exceeded.')
			db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?)').run(
				id,
				name,
				artifact.hash,
				artifact.bytes,
			)
		})
		return artifact
	}

	async readArtifact(cycleId: string, name: string): Promise<unknown> {
		const artifact = (await this.artifacts(cycleId)).find((item) => item.name === name)
		if (!artifact) throw new Error('Learning artifact is not retained in this scope.')
		z.string()
			.regex(/^[0-9a-f]{64}$/)
			.parse(artifact.hash)
		const path = join(this.artifactsPath, `${artifact.hash}.json`)
		const entry = lstatSync(path)
		if (
			!entry.isFile() ||
			entry.isSymbolicLink() ||
			entry.size !== artifact.bytes ||
			entry.size > MAX_ARTIFACT_BYTES
		)
			throw new Error('Learning artifact is not a regular file of the recorded size.')
		const body = readFileSync(path)
		if (digest(body) !== artifact.hash) throw new Error('Learning artifact hash mismatch.')
		return JSON.parse(body.toString('utf8'))
	}
}

/** @experimental Supply normal host callbacks; the store retains journal events and full paired batches. */
export async function runStoredResidentLearningCycle(
	store: SqliteResidentLearningStore,
	options: Omit<ResidentLearningCycleOptions, 'record'>,
): Promise<ResidentLearningCycleResult> {
	return runResidentLearningCycle({
		...options,
		record: (event) => store.append(event),
		evaluate: async (context) => {
			const value = await options.evaluate(context)
			await store.putArtifact(context.cycleId, context.stage, value.batch)
			return value
		},
	})
}

/** @experimental Host authorizes evaluators; the SDK selects a retained failure against the active skill. */
export interface ResidentLearningDiscoveryOptions
	extends Omit<ResidentLearningCycleOptions, 'record' | 'failure' | 'skillName'> {
	readonly evaluators: readonly { readonly skillName: string; readonly evaluatorRevision: string }[]
}

/** @experimental Null cycle means no eligible work. A failed claimed cycle is never silently replayed. */
export interface ResidentLearningDiscoveryResult {
	readonly observation: ResidentLearningObservationRecord | null
	readonly cycle: ResidentLearningCycleResult | null
}

/**
 * @experimental Admit at most one experiment from host-scored observations.
 * Selection is local FIFO fairness, not an estimated probability of improvement.
 * Claim and start are one SQLite transaction; concurrent selectors cannot run
 * the same task/evaluator/baseline twice, even after a crash or reopened process.
 */
export async function runStoredResidentLearningFromObservations(
	store: SqliteResidentLearningStore,
	options: ResidentLearningDiscoveryOptions,
): Promise<ResidentLearningDiscoveryResult> {
	options.signal.throwIfAborted()
	const agenda = await options.agenda.read()
	if (!agenda || agenda.paused || agenda.pursuits.some((p) => p.state.phase === 'running'))
		throw new Error('Learning discovery requires an unpaused agenda without running pursuits.')
	const targets = options.evaluators.map((target) => {
		const skill = agenda.learning?.skills.find((s) => s.name === target.skillName)
		return { ...target, baselineRevision: skill ? hashResidentSkill(skill) : 'none' }
	})
	const observation = await store.selectObservation(targets)
	options.signal.throwIfAborted()
	if (!observation) return { observation: null, cycle: null }
	const cycle = await runResidentLearningCycle({
		...options,
		skillName: observation.skillName,
		failure: { evidence: observation.evidence, trace: observation.trace },
		record: (event) =>
			store.append(
				event.kind === 'started'
					? { ...event, data: { ...event.data, observation: { ordinal: observation.ordinal } } }
					: event,
			),
		evaluate: async (context) => {
			const value = await options.evaluate(context)
			await store.putArtifact(context.cycleId, context.stage, value.batch)
			return value
		},
	})
	return { observation, cycle }
}
