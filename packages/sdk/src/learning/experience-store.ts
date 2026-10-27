import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ProjectId, TenantId } from '../types/ids/index.js'
import { asProjectId, asTenantId } from '../utils/id.js'
import {
	type LearningExperienceEntry,
	type LearningExperienceInput,
	type LearningExperienceQuery,
	assertExperienceHasNoLeak,
	normalizeLearningExperience,
	selectLearningExperience,
} from './experience.js'

const SCHEMA = `
CREATE TABLE experience (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, agent_key TEXT NOT NULL,
  domain TEXT NOT NULL, cycle_id TEXT NOT NULL, evaluator_revision TEXT NOT NULL,
  decision TEXT NOT NULL, body TEXT NOT NULL,
  UNIQUE(tenant_id, project_id, agent_key, cycle_id)
);
CREATE INDEX experience_read ON experience(
  tenant_id, project_id, agent_key, domain, evaluator_revision, ordinal
);
`

/** The schema version this store reads and writes. */
export const LEARNING_EXPERIENCE_STORE_VERSION = 1

/** @experimental Where the library lives; a separate file from the observation journal. */
export interface SqliteLearningExperienceStoreOptions {
	readonly databasePath: string
	readonly scope: {
		readonly tenantId: TenantId
		readonly projectId: ProjectId
		readonly agentKey: string
	}
	readonly readOnly?: boolean
}

type Row = { ordinal: number; body: string }

/**
 * @experimental Durable experience library. Entries are immutable: recording
 * the same cycle again with identical content returns the stored entry, with
 * different content is refused. The artefact is stored whole.
 */
export class SqliteLearningExperienceStore {
	readonly databasePath: string
	private readonly scope: SqliteLearningExperienceStoreOptions['scope']
	private readonly readOnly: boolean

	constructor(options: SqliteLearningExperienceStoreOptions) {
		this.databasePath = resolve(options.databasePath)
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

	private use<T>(write: boolean, operation: (db: DatabaseSync) => T, whenEmpty?: () => T): T {
		if (write && this.readOnly) throw new Error('Learning experience database is read-only.')
		let Database: typeof DatabaseSync
		try {
			Database = (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
				.DatabaseSync
		} catch (error) {
			throw new Error('SqliteLearningExperienceStore requires Node.js 22.13 or newer.', {
				cause: error,
			})
		}
		if (!this.readOnly) mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
		const db = new Database(this.databasePath, { readOnly: this.readOnly })
		try {
			db.exec('PRAGMA busy_timeout = 5000;')
			if (!this.readOnly) db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;')
			db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
			try {
				const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
				if (version === 0 && write) {
					db.exec(`${SCHEMA} PRAGMA user_version = ${LEARNING_EXPERIENCE_STORE_VERSION};`)
				} else if (version === 0) {
					if (whenEmpty) {
						db.exec('COMMIT')
						return whenEmpty()
					}
					throw new Error(
						'Learning experience database is not initialized; open it for writing first.',
					)
				} else if (version !== LEARNING_EXPERIENCE_STORE_VERSION)
					throw new Error(
						`Learning experience database is at schema version ${version}; this store reads version ${LEARNING_EXPERIENCE_STORE_VERSION} only.`,
					)
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

	private scopeArgs(): [string, string, string] {
		return [this.scope.tenantId, this.scope.projectId, this.scope.agentKey]
	}

	private decode(row: Row): LearningExperienceEntry {
		return {
			...(JSON.parse(row.body) as Omit<LearningExperienceEntry, 'ordinal'>),
			ordinal: row.ordinal,
		}
	}

	/** Record one finished cycle. Throws `LearningLeakError` when the entry carries evaluator-side material. */
	async record(input: LearningExperienceInput): Promise<LearningExperienceEntry> {
		if (!input.leakGuard) throw new Error('Recording an experience entry requires a leakGuard.')
		const entry = normalizeLearningExperience(input)
		assertExperienceHasNoLeak(entry, input.leakGuard)
		const body = JSON.stringify(entry)
		return this.use(true, (db) => {
			const existing = db
				.prepare(
					'SELECT ordinal, body FROM experience WHERE tenant_id=? AND project_id=? AND agent_key=? AND cycle_id=?',
				)
				.get(...this.scopeArgs(), entry.cycleId) as Row | undefined
			if (existing) {
				if (existing.body !== body)
					throw new Error(
						'This cycle already has a different experience entry; entries are immutable.',
					)
				return this.decode(existing)
			}
			const result = db
				.prepare(
					'INSERT INTO experience (tenant_id, project_id, agent_key, domain, cycle_id, evaluator_revision, decision, body) VALUES (?,?,?,?,?,?,?,?)',
				)
				.run(
					...this.scopeArgs(),
					entry.domain,
					entry.cycleId,
					entry.evaluatorRevision,
					entry.decision,
					body,
				)
			return { ...entry, ordinal: Number(result.lastInsertRowid) }
		})
	}

	/** The ordinal the next entry will be recorded after; pass it as `beforeOrdinal` to read everything so far. */
	async nextOrdinal(): Promise<number> {
		return this.use(
			false,
			(db) => {
				const row = db
					.prepare(
						'SELECT MAX(ordinal) AS last FROM experience WHERE tenant_id=? AND project_id=? AND agent_key=?',
					)
					.get(...this.scopeArgs()) as { last: number | null }
				return (row.last ?? 0) + 1
			},
			() => 1,
		)
	}

	/** Entries of one domain and evaluator revision recorded before `beforeOrdinal`, newest first. */
	async retrieve(query: LearningExperienceQuery): Promise<LearningExperienceEntry[]> {
		const rows = this.use(
			false,
			(db) =>
				db
					.prepare(
						'SELECT ordinal, body FROM experience WHERE tenant_id=? AND project_id=? AND agent_key=? AND domain=? AND evaluator_revision=? AND ordinal<? ORDER BY ordinal DESC',
					)
					.all(
						...this.scopeArgs(),
						query.domain,
						query.evaluatorRevision,
						query.beforeOrdinal,
					) as Row[],
			() => [],
		)
		if (!query.leakGuard) throw new Error('Retrieving experience entries requires a leakGuard.')
		const selected = selectLearningExperience(
			rows.map((row) => this.decode(row)),
			query,
		)
		for (const { ordinal: _ordinal, ...entry } of selected)
			assertExperienceHasNoLeak(entry, query.leakGuard)
		return selected
	}
}
