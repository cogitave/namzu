import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import type { ProjectId, SessionId, TurnId } from '../../types/ids/index.js'
import type { TurnExecutionStatus } from '../../types/session/turn.js'
import { uuidv7 } from '../../utils/uuidv7.js'
import { evidenceMatcher, ftsMatchExpression } from './fts.js'
import type {
	ChildSessionSummary,
	EvidenceHit,
	EvidenceSearchOptions,
	IndexedBatch,
	IndexedPendingDecision,
	IndexedSession,
	IndexedSessionStatus,
	IndexedTurn,
	IndexedTurnStatus,
	ListSessionsOptions,
} from './index.js'
import {
	type BatchRow,
	type ChildRow,
	type DecisionRow,
	type EvidenceRow,
	type IndexSink,
	SessionIndexBase,
	SessionIndexError,
	type SessionRow,
	type TurnRow,
	batchView,
	childView,
	decisionView,
	discoverSessionLogs,
	evidenceView,
	pathExists,
	sessionView,
	turnView,
} from './rebuild.js'
import type { ExternalRefClaim, ExternalRefKind, ExternalRefTarget } from './refs.js'

/** `PRAGMA user_version` of an index this module writes. Any other version is rebuilt, never migrated. */
export const SESSION_INDEX_VERSION = 1

type SqliteModule = typeof import('node:sqlite')

let sqliteModule: SqliteModule | null | undefined

/**
 * `node:sqlite`, or `undefined` where it does not load (Node 20, and Node 22
 * before 22.13 without `--experimental-sqlite`). Loaded lazily so importing
 * the SDK never requires SQLite.
 */
function loadSqlite(): SqliteModule | undefined {
	if (sqliteModule === undefined) {
		try {
			sqliteModule = createRequire(import.meta.url)('node:sqlite') as SqliteModule
		} catch {
			sqliteModule = null
		}
	}
	return sqliteModule ?? undefined
}

/** Whether `node:sqlite` loads in this process, so {@link SqliteSessionIndex} can run. */
export function sqliteAvailable(): boolean {
	return loadSqlite() !== undefined
}

function requireSqlite(): SqliteModule {
	const module = loadSqlite()
	if (module === undefined) {
		throw new SessionIndexError(
			'SqliteSessionIndex needs node:sqlite (Node.js 22.13 or newer); use ScanSessionIndex instead.',
		)
	}
	return module
}

/**
 * The schema of spec §4.6, plus `children` (each child a parent log names,
 * from which `batches` is kept) and the claim columns of `external_refs`.
 * Every table is derived; `PRAGMA user_version` is set in the same script.
 *
 * `external_refs` holds every session's claim on a name, keyed by
 * `(protocol, kind, external_id, session_id)`, and a lookup takes the
 * earliest. A single-owner key would make the answer depend on which log was
 * indexed first, and a rebuild could then disagree with the index it replaces.
 */
const SCHEMA = `
CREATE TABLE projects (slug TEXT PRIMARY KEY, project_id TEXT NOT NULL, cwd TEXT NOT NULL);
CREATE TABLE sessions (
	id TEXT PRIMARY KEY, slug TEXT NOT NULL, project_id TEXT NOT NULL, parent_id TEXT, root_id TEXT NOT NULL,
	depth INTEGER NOT NULL, title TEXT, archived INTEGER NOT NULL, status TEXT NOT NULL,
	created_at TEXT NOT NULL, updated_at TEXT NOT NULL, log_path TEXT NOT NULL,
	log_bytes INTEGER NOT NULL, head_seq INTEGER NOT NULL, head_sha256 TEXT NOT NULL);
CREATE INDEX sessions_parent ON sessions(parent_id);
CREATE INDEX sessions_listing ON sessions(created_at, id);
CREATE TABLE turns (
	id TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, stop_reason TEXT,
	started_at TEXT NOT NULL, ended_at TEXT, tokens INTEGER NOT NULL, cost_usd REAL NOT NULL,
	user_preview TEXT, origin_kind TEXT, PRIMARY KEY (session_id, id));
CREATE TABLE pending_decisions (
	decision_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
	checkpoint_id TEXT NOT NULL, deadline_at TEXT, PRIMARY KEY (session_id, decision_id));
CREATE TABLE external_refs (
	protocol TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL, session_id TEXT NOT NULL,
	turn_id TEXT, claimed_at TEXT NOT NULL, claimed_seq INTEGER NOT NULL,
	PRIMARY KEY (protocol, kind, external_id, session_id));
CREATE INDEX external_refs_session ON external_refs(session_id);
CREATE TABLE children (
	session_id TEXT NOT NULL, child_id TEXT NOT NULL, turn_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
	kind TEXT NOT NULL, description TEXT NOT NULL, path TEXT NOT NULL, batch_id TEXT, batch_name TEXT,
	batch_phase TEXT, status TEXT NOT NULL, stop_reason TEXT, tokens INTEGER NOT NULL,
	cost_usd REAL NOT NULL, spawned_at TEXT NOT NULL, ended_at TEXT, PRIMARY KEY (session_id, child_id));
CREATE TABLE batches (
	batch_id TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL, phase TEXT,
	agents_done INTEGER NOT NULL, agents_total INTEGER NOT NULL, tokens_total INTEGER NOT NULL,
	PRIMARY KEY (session_id, batch_id));
CREATE VIRTUAL TABLE evidence_fts USING fts5(
	text, session_id UNINDEXED, turn_id UNINDEXED, seq UNINDEXED, part UNINDEXED, source UNINDEXED,
	tool_name UNINDEXED, is_error UNINDEXED, tokenize = 'trigram');
PRAGMA user_version = ${SESSION_INDEX_VERSION};
`

type Row = Record<string, unknown>

const text = (value: unknown): string => String(value)
const optionalText = (value: unknown): string | null =>
	value === null || value === undefined ? null : String(value)
const num = (value: unknown): number => Number(value)

function sessionRow(row: Row): SessionRow {
	return {
		id: text(row.id) as SessionId,
		slug: text(row.slug),
		projectId: text(row.project_id) as ProjectId,
		parentId: optionalText(row.parent_id) as SessionId | null,
		rootId: text(row.root_id) as SessionId,
		depth: num(row.depth),
		title: optionalText(row.title),
		archived: num(row.archived) === 1,
		status: text(row.status) as IndexedSessionStatus,
		createdAt: text(row.created_at),
		updatedAt: text(row.updated_at),
		logPath: text(row.log_path),
		logBytes: num(row.log_bytes),
		headSeq: num(row.head_seq),
		headSha256: text(row.head_sha256),
	}
}

function turnRow(row: Row): TurnRow {
	return {
		id: text(row.id) as TurnId,
		sessionId: text(row.session_id) as SessionId,
		status: text(row.status) as IndexedTurnStatus,
		stopReason: optionalText(row.stop_reason),
		startedAt: text(row.started_at),
		endedAt: optionalText(row.ended_at),
		tokens: num(row.tokens),
		costUsd: num(row.cost_usd),
		userPreview: optionalText(row.user_preview),
		originKind: optionalText(row.origin_kind),
	}
}

function decisionRow(row: Row): DecisionRow {
	return {
		decisionId: text(row.decision_id),
		sessionId: text(row.session_id) as SessionId,
		turnId: text(row.turn_id) as TurnId,
		checkpointId: text(row.checkpoint_id),
		deadlineAt: optionalText(row.deadline_at),
	}
}

function childRow(row: Row): ChildRow {
	return {
		sessionId: text(row.session_id) as SessionId,
		childId: text(row.child_id) as SessionId,
		turnId: text(row.turn_id) as TurnId,
		toolCallId: text(row.tool_call_id),
		kind: text(row.kind),
		description: text(row.description),
		path: text(row.path),
		batchId: optionalText(row.batch_id),
		batchName: optionalText(row.batch_name),
		batchPhase: optionalText(row.batch_phase),
		status: text(row.status) as TurnExecutionStatus,
		stopReason: optionalText(row.stop_reason),
		tokens: num(row.tokens),
		costUsd: num(row.cost_usd),
		spawnedAt: text(row.spawned_at),
		endedAt: optionalText(row.ended_at),
	}
}

function batchRow(row: Row): BatchRow {
	return {
		batchId: text(row.batch_id),
		sessionId: text(row.session_id) as SessionId,
		name: text(row.name),
		phase: optionalText(row.phase),
		agentsDone: num(row.agents_done),
		agentsTotal: num(row.agents_total),
		tokensTotal: num(row.tokens_total),
	}
}

function evidenceRow(row: Row): EvidenceRow {
	return {
		sessionId: text(row.session_id) as SessionId,
		turnId: optionalText(row.turn_id) as TurnId | null,
		seq: num(row.seq),
		part: num(row.part),
		source: text(row.source),
		toolName: optionalText(row.tool_name),
		isError: row.is_error === null || row.is_error === undefined ? null : num(row.is_error) === 1,
		text: text(row.text),
	}
}

function claimTargetRow(row: Row): ExternalRefTarget {
	const turnId = optionalText(row.turn_id)
	return {
		protocol: text(row.protocol),
		kind: text(row.kind) as ExternalRefKind,
		externalId: text(row.external_id),
		sessionId: text(row.session_id) as SessionId,
		...(turnId === null ? {} : { turnId: turnId as TurnId }),
	}
}

function configure(db: DatabaseSync): void {
	// A rollback journal, not WAL: a rebuild renames a finished file over the
	// index, and a WAL beside the old file would not belong to the new one.
	db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL;')
}

/** Whether a process with this pid is running on this machine. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM: it runs, under another user.
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/**
 * How long a temporary file must go unmodified before a sweep may call it
 * abandoned. A live rebuild commits once per session log, so its file (or
 * its journal) is touched far more often than this.
 */
export const ABANDONED_REBUILD_AFTER_MS = 60 * 60 * 1000

/** Last modification of `path` in ms, or null when it is gone. */
async function modifiedAt(path: string): Promise<number | null> {
	try {
		return (await stat(path)).mtimeMs
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
}

/**
 * Remove the temporary files (and their journals) that a rebuild of the index
 * at `path` left behind when its process died before its own cleanup ran.
 *
 * A file is abandoned only when both hold: no process with its pid runs here,
 * and neither it nor its journal changed for {@link ABANDONED_REBUILD_AFTER_MS}.
 * The pid alone is not enough. A process in another PID namespace (a
 * container or sandbox sharing this home) writes a pid that means nothing
 * here, and its rebuild is live however dead the pid looks.
 */
async function sweepAbandonedRebuilds(path: string): Promise<void> {
	const directory = dirname(path)
	const prefix = `${basename(path)}.tmp-`
	let names: string[]
	try {
		names = await readdir(directory)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
		throw error
	}
	// One entry per rebuild: its file and its journal go together.
	const stems = new Set<string>()
	for (const name of names) {
		if (!name.startsWith(prefix)) continue
		const pid = Number(/^(\d+)-/.exec(name.slice(prefix.length))?.[1])
		if (!Number.isSafeInteger(pid) || pid <= 0 || processAlive(pid)) continue
		stems.add(name.endsWith('-journal') ? name.slice(0, -'-journal'.length) : name)
	}
	const cutoff = Date.now() - ABANDONED_REBUILD_AFTER_MS
	for (const stem of stems) {
		const file = join(directory, stem)
		const journal = `${file}-journal`
		const touched = [await modifiedAt(file), await modifiedAt(journal)]
		if (touched.some((at) => at !== null && at > cutoff)) continue
		await rm(file, { force: true })
		await rm(journal, { force: true })
	}
}

function userVersion(db: DatabaseSync): number {
	return Number(db.prepare('PRAGMA user_version').get()?.user_version)
}

/**
 * The version of the index file at `path`: -1 when there is none, 0 when it
 * cannot be read as a SQLite database, otherwise its `user_version`.
 */
function indexVersion(path: string): number {
	const { DatabaseSync } = requireSqlite()
	let db: DatabaseSync
	try {
		db = new DatabaseSync(path, { readOnly: true })
	} catch {
		return -1
	}
	try {
		db.exec('PRAGMA busy_timeout = 10000')
		return userVersion(db)
	} catch {
		return 0
	} finally {
		db.close()
	}
}

export interface SqliteSessionIndexOptions {
	/** The index file, normally `$NAMZU_HOME/index.sqlite`. */
	readonly path: string
	/** The home whose logs the index describes. */
	readonly home: string
}

export interface RebuildSqliteSessionIndexOptions extends SqliteSessionIndexOptions {
	/**
	 * Replace a current index too. Without it, a rebuild that finds a current
	 * index already in place (another process finished first) discards its own.
	 */
	readonly force?: boolean
}

/**
 * Build the index from every log under `home` into a temporary file beside
 * it (`index.sqlite.tmp-<pid>-<uuidv7>`), then rename that file over the
 * index. A reader therefore sees the old index or the complete new one,
 * never a partial one. When two processes rebuild at once both finish and
 * one complete index remains: a process that finds a current index already
 * renamed into place discards its temporary file. A temporary file left by
 * a process that died mid-rebuild is removed by a later rebuild or open, once
 * it has gone unmodified for {@link ABANDONED_REBUILD_AFTER_MS}.
 *
 * Returns whether this call's file became the index.
 */
export function rebuildSqliteSessionIndex(
	options: RebuildSqliteSessionIndexOptions,
): Promise<boolean> {
	return SqliteSessionIndex.rebuild(options)
}

/**
 * The index in SQLite. Every write runs under `BEGIN IMMEDIATE`, so two
 * processes updating one index serialise; the rows are derived from the logs
 * alone, so the order they serialise in does not change the result.
 */
export class SqliteSessionIndex extends SessionIndexBase {
	readonly backend = 'sqlite' as const
	readonly #db: DatabaseSync
	readonly #sink: IndexSink
	readonly #statements = new Map<string, StatementSync>()
	#open = true

	/** Wraps an open database whose schema is current. Use {@link SqliteSessionIndex.open}. */
	private constructor(db: DatabaseSync) {
		super()
		this.#db = db
		const run = (sql: string, ...values: SQLInputValue[]) => {
			this.#statement(sql).run(...values)
		}
		const get = (sql: string, ...values: SQLInputValue[]) =>
			this.#statement(sql).get(...values) as Row | undefined
		this.#sink = {
			getSession: (id) => {
				const row = get('SELECT * FROM sessions WHERE id = ?', id)
				return row === undefined ? undefined : sessionRow(row)
			},
			putSession: (row) =>
				run(
					`INSERT INTO sessions (id, slug, project_id, parent_id, root_id, depth, title, archived, status,
						created_at, updated_at, log_path, log_bytes, head_seq, head_sha256)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, project_id = excluded.project_id,
						parent_id = excluded.parent_id, root_id = excluded.root_id, depth = excluded.depth,
						title = excluded.title, archived = excluded.archived, status = excluded.status,
						created_at = excluded.created_at, updated_at = excluded.updated_at,
						log_path = excluded.log_path, log_bytes = excluded.log_bytes,
						head_seq = excluded.head_seq, head_sha256 = excluded.head_sha256`,
					row.id,
					row.slug,
					row.projectId,
					row.parentId,
					row.rootId,
					row.depth,
					row.title,
					row.archived ? 1 : 0,
					row.status,
					row.createdAt,
					row.updatedAt,
					row.logPath,
					row.logBytes,
					row.headSeq,
					row.headSha256,
				),
			putProject: (slug, projectId, cwd) =>
				run(
					'INSERT INTO projects (slug, project_id, cwd) VALUES (?, ?, ?) ON CONFLICT (slug) DO NOTHING',
					slug,
					projectId,
					cwd,
				),
			getTurn: (sessionId, turnId) => {
				const row = get('SELECT * FROM turns WHERE session_id = ? AND id = ?', sessionId, turnId)
				return row === undefined ? undefined : turnRow(row)
			},
			putTurn: (row) =>
				run(
					`INSERT OR REPLACE INTO turns (id, session_id, status, stop_reason, started_at, ended_at,
						tokens, cost_usd, user_preview, origin_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					row.id,
					row.sessionId,
					row.status,
					row.stopReason,
					row.startedAt,
					row.endedAt,
					row.tokens,
					row.costUsd,
					row.userPreview,
					row.originKind,
				),
			putDecision: (row) =>
				run(
					`INSERT OR REPLACE INTO pending_decisions (decision_id, session_id, turn_id, checkpoint_id,
						deadline_at) VALUES (?, ?, ?, ?, ?)`,
					row.decisionId,
					row.sessionId,
					row.turnId,
					row.checkpointId,
					row.deadlineAt,
				),
			deleteDecision: (sessionId, decisionId) =>
				run(
					'DELETE FROM pending_decisions WHERE session_id = ? AND decision_id = ?',
					sessionId,
					decisionId,
				),
			deleteTurnDecisions: (sessionId, turnId) =>
				run(
					'DELETE FROM pending_decisions WHERE session_id = ? AND turn_id = ?',
					sessionId,
					turnId,
				),
			claimRef: (claim: ExternalRefClaim) =>
				run(
					`INSERT INTO external_refs (protocol, kind, external_id, session_id, turn_id, claimed_at,
						claimed_seq) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
					claim.protocol,
					claim.kind,
					claim.externalId,
					claim.sessionId,
					claim.turnId ?? null,
					claim.claimedAt,
					claim.claimedSeq,
				),
			releaseRef: (protocol, kind, externalId, sessionId) =>
				run(
					'DELETE FROM external_refs WHERE protocol = ? AND kind = ? AND external_id = ? AND session_id = ?',
					protocol,
					kind,
					externalId,
					sessionId,
				),
			getChild: (sessionId, childId) => {
				const row = get(
					'SELECT * FROM children WHERE session_id = ? AND child_id = ?',
					sessionId,
					childId,
				)
				return row === undefined ? undefined : childRow(row)
			},
			putChild: (row) =>
				run(
					`INSERT OR REPLACE INTO children (session_id, child_id, turn_id, tool_call_id, kind, description,
						path, batch_id, batch_name, batch_phase, status, stop_reason, tokens, cost_usd, spawned_at,
						ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					row.sessionId,
					row.childId,
					row.turnId,
					row.toolCallId,
					row.kind,
					row.description,
					row.path,
					row.batchId,
					row.batchName,
					row.batchPhase,
					row.status,
					row.stopReason,
					row.tokens,
					row.costUsd,
					row.spawnedAt,
					row.endedAt,
				),
			getBatch: (sessionId, batchId) => {
				const row = get(
					'SELECT * FROM batches WHERE session_id = ? AND batch_id = ?',
					sessionId,
					batchId,
				)
				return row === undefined ? undefined : batchRow(row)
			},
			putBatch: (row) =>
				run(
					`INSERT OR REPLACE INTO batches (batch_id, session_id, name, phase, agents_done, agents_total,
						tokens_total) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					row.batchId,
					row.sessionId,
					row.name,
					row.phase,
					row.agentsDone,
					row.agentsTotal,
					row.tokensTotal,
				),
			putEvidence: (row) =>
				run(
					`INSERT INTO evidence_fts (text, session_id, turn_id, seq, part, source, tool_name, is_error)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					row.text,
					row.sessionId,
					row.turnId,
					row.seq,
					row.part,
					row.source,
					row.toolName,
					row.isError === null ? null : row.isError ? 1 : 0,
				),
			clearSession: (sessionId) => {
				for (const table of [
					'turns',
					'pending_decisions',
					'external_refs',
					'children',
					'batches',
					'evidence_fts',
				]) {
					run(`DELETE FROM ${table} WHERE session_id = ?`, sessionId)
				}
				run('DELETE FROM sessions WHERE id = ?', sessionId)
			},
		}
	}

	/** See {@link rebuildSqliteSessionIndex}. */
	static async rebuild(options: RebuildSqliteSessionIndexOptions): Promise<boolean> {
		const { DatabaseSync } = requireSqlite()
		await mkdir(dirname(options.path), { recursive: true })
		await sweepAbandonedRebuilds(options.path)
		const temporary = `${options.path}.tmp-${process.pid}-${uuidv7()}`
		try {
			const db = new DatabaseSync(temporary)
			const index = new SqliteSessionIndex(db)
			try {
				configure(db)
				db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`)
				for (const log of await discoverSessionLogs(options.home)) await index.refresh(log)
			} finally {
				index.close()
			}
			if (!options.force && (await pathExists(options.path))) {
				if (indexVersion(options.path) === SESSION_INDEX_VERSION) return false
			}
			await rename(temporary, options.path)
			return true
		} finally {
			await rm(temporary, { force: true })
			await rm(`${temporary}-journal`, { force: true })
		}
	}

	/**
	 * Open the index at `path` for the logs under `home`. A missing index, or
	 * one at another `user_version` (or not a database at all), is rebuilt,
	 * never migrated; a current one is brought up to date with the logs.
	 */
	static async open(options: SqliteSessionIndexOptions): Promise<SqliteSessionIndex> {
		const { DatabaseSync } = requireSqlite()
		if (indexVersion(options.path) !== SESSION_INDEX_VERSION) {
			// Not forced: if another process renames a current index into place
			// first, this one discards its own and opens that one.
			await SqliteSessionIndex.rebuild(options)
		} else {
			await sweepAbandonedRebuilds(options.path)
		}
		const db = new DatabaseSync(options.path)
		try {
			configure(db)
			if (userVersion(db) !== SESSION_INDEX_VERSION) {
				throw new SessionIndexError(`The index at ${options.path} changed version while opening.`)
			}
		} catch (error) {
			db.close()
			throw error
		}
		const index = new SqliteSessionIndex(db)
		await index.sync(options.home)
		return index
	}

	protected transaction<T>(work: (sink: IndexSink) => T): T {
		this.#db.exec('BEGIN IMMEDIATE')
		try {
			const result = work(this.#sink)
			this.#db.exec('COMMIT')
			return result
		} catch (error) {
			this.#db.exec('ROLLBACK')
			throw error
		}
	}

	/** One prepared statement per distinct SQL text, for the life of the connection. */
	#statement(sql: string): StatementSync {
		let statement = this.#statements.get(sql)
		if (statement === undefined) {
			statement = this.#db.prepare(sql)
			this.#statements.set(sql, statement)
		}
		return statement
	}

	#all(sql: string, ...values: SQLInputValue[]): Row[] {
		return this.#statement(sql).all(...values) as Row[]
	}

	protected readSession(sessionId: SessionId): SessionRow | undefined {
		const row = this.#statement('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
			| Row
			| undefined
		return row === undefined ? undefined : sessionRow(row)
	}

	protected indexedSessionIds(): SessionId[] {
		return this.#all('SELECT id FROM sessions').map((row) => text(row.id) as SessionId)
	}

	async listSessions(options: ListSessionsOptions = {}): Promise<IndexedSession[]> {
		const where: string[] = []
		const values: SQLInputValue[] = []
		if (options.slug !== undefined) {
			where.push('slug = ?')
			values.push(options.slug)
		}
		if (options.rootsOnly === true) where.push('parent_id IS NULL')
		if (options.includeArchived === false) where.push('archived = 0')
		const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
		return this.#all(`SELECT * FROM sessions ${clause} ORDER BY created_at, id`, ...values).map(
			(row) => sessionView(sessionRow(row)),
		)
	}

	async listTurns(sessionId: SessionId): Promise<IndexedTurn[]> {
		return this.#all(
			'SELECT * FROM turns WHERE session_id = ? ORDER BY started_at, id',
			sessionId,
		).map((row) => turnView(turnRow(row)))
	}

	async listChildren(sessionId: SessionId): Promise<ChildSessionSummary[]> {
		return this.#all(
			'SELECT * FROM children WHERE session_id = ? ORDER BY spawned_at, child_id',
			sessionId,
		).map((row) => {
			const child = childRow(row)
			return childView(child, this.readSession(child.childId))
		})
	}

	async listPendingDecisions(
		options: { sessionId?: SessionId } = {},
	): Promise<IndexedPendingDecision[]> {
		const rows =
			options.sessionId === undefined
				? this.#all('SELECT * FROM pending_decisions ORDER BY session_id, decision_id')
				: this.#all(
						'SELECT * FROM pending_decisions WHERE session_id = ? ORDER BY session_id, decision_id',
						options.sessionId,
					)
		return rows.map((row) => decisionView(decisionRow(row)))
	}

	async resolveExternal(
		protocol: string,
		kind: ExternalRefKind,
		externalId: string,
	): Promise<ExternalRefTarget | undefined> {
		const row = this.#db
			.prepare(
				`SELECT * FROM external_refs WHERE protocol = ? AND kind = ? AND external_id = ?
				ORDER BY claimed_at, session_id, claimed_seq LIMIT 1`,
			)
			.get(protocol, kind, externalId) as Row | undefined
		return row === undefined ? undefined : claimTargetRow(row)
	}

	async listExternalRefs(sessionId: SessionId): Promise<ExternalRefTarget[]> {
		return this.#all(
			'SELECT * FROM external_refs WHERE session_id = ? ORDER BY protocol, kind, external_id',
			sessionId,
		).map(claimTargetRow)
	}

	async batches(options: { sessionId?: SessionId } = {}): Promise<IndexedBatch[]> {
		const rows =
			options.sessionId === undefined
				? this.#all('SELECT * FROM batches ORDER BY session_id, batch_id')
				: this.#all(
						'SELECT * FROM batches WHERE session_id = ? ORDER BY session_id, batch_id',
						options.sessionId,
					)
		return rows.map((row) => batchView(batchRow(row)))
	}

	async searchEvidence(options: EvidenceSearchOptions): Promise<EvidenceHit[]> {
		const match = evidenceMatcher(options)
		const narrowing = ftsMatchExpression(options)
		const limit = options.limit ?? 100
		const where: string[] = []
		const values: SQLInputValue[] = []
		if (narrowing !== undefined) {
			where.push('evidence_fts MATCH ?')
			values.push(narrowing)
		}
		if (options.sessionId !== undefined) {
			where.push('session_id = ?')
			values.push(options.sessionId)
		}
		const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
		const statement = this.#db.prepare(
			`SELECT text, session_id, turn_id, seq, part, source, tool_name, is_error FROM evidence_fts
			${clause} ORDER BY session_id, seq, part`,
		)
		const hits: EvidenceHit[] = []
		for (const raw of statement.iterate(...values)) {
			const row = evidenceRow(raw as Row)
			const found = match(row.text)
			if (found === undefined) continue
			hits.push(evidenceView(row, found))
			if (hits.length >= limit) break
		}
		return hits
	}

	close(): void {
		if (!this.#open) return
		this.#open = false
		this.#db.close()
	}
}
