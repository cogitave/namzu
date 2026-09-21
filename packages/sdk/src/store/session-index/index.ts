import { join } from 'node:path'
import { resolveNamzuHome } from '../../session/home.js'
import type { ProjectId, SessionId, TurnId } from '../../types/ids/index.js'
import type { RecordPointer, SessionRecord } from '../../types/session/records.js'
import type { TurnExecutionStatus } from '../../types/session/turn.js'
import type { EvidenceQuery } from './fts.js'
import type { ExternalRefKind, ExternalRefTarget } from './refs.js'
import { ScanSessionIndex } from './scan.js'
import { SqliteSessionIndex, sqliteAvailable } from './sqlite.js'

/**
 * The rebuildable index over every session log under `NAMZU_HOME`
 * (`$NAMZU_HOME/index.sqlite`, spec §4.6).
 *
 * The logs are the source of truth; every row here is derived from their
 * records and nothing is written directly, so deleting the index loses
 * nothing. `SqliteSessionIndex` keeps it in SQLite where `node:sqlite` loads
 * (Node 22.13+); elsewhere `ScanSessionIndex` derives the same answers in
 * memory from the logs.
 */

/** One record as a log reader yields it: the record and where it sits in its file. */
export interface IndexableRecord {
	readonly record: SessionRecord
	readonly pointer: RecordPointer
}

/** One session log to index, as records. */
export interface SessionLogInput {
	/** The project slug the log is filed under (`projects/<slug>/`). */
	readonly slug: string
	/** The log's path, recorded so a later check can compare the file with the index. */
	readonly logPath: string
	/**
	 * The records, in order. Starting at seq 1 re-derives the session from
	 * scratch; starting right after the indexed head continues it; anything
	 * else is refused.
	 */
	readonly records: AsyncIterable<IndexableRecord> | Iterable<IndexableRecord>
}

/**
 * `running`: a turn is open and not parked (the index cannot see leases, so
 * an interrupted turn also reads `running`); `paused`: the open turn is
 * parked; `idle`: no turn is open.
 */
export type IndexedSessionStatus = 'idle' | 'running' | 'paused'

export interface IndexedSession {
	readonly id: SessionId
	readonly slug: string
	readonly projectId: ProjectId
	readonly parentId?: SessionId
	readonly rootId: SessionId
	/** 0 for a root session. */
	readonly depth: number
	readonly title?: string
	readonly archived: boolean
	readonly status: IndexedSessionStatus
	readonly createdAt: string
	readonly updatedAt: string
	readonly logPath: string
	/** Bytes of the log the index has read: the end of the head record. */
	readonly logBytes: number
	readonly headSeq: number
	readonly headSha256: string
}

/** A turn's state as its records leave it. `paused` is parked, not terminal. */
export type IndexedTurnStatus = 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'

export interface IndexedTurn {
	readonly id: TurnId
	readonly sessionId: SessionId
	readonly status: IndexedTurnStatus
	readonly stopReason?: string
	readonly startedAt: string
	readonly endedAt?: string
	/** The settled total; 0 until the turn settles. */
	readonly tokens: number
	readonly costUsd: number
	/** The first 200 characters of the prompt that opened the turn. */
	readonly userPreview?: string
	readonly originKind?: string
}

/** A decision a parked turn is waiting on. */
export interface IndexedPendingDecision {
	readonly decisionId: string
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly checkpointId: string
	readonly deadlineAt?: string
}

/** A child session as its parent's log describes it, with the child's own row once its log is indexed. */
export interface ChildSessionSummary {
	readonly sessionId: SessionId
	readonly parentSessionId: SessionId
	readonly parentTurnId: TurnId
	readonly toolCallId: string
	readonly kind: string
	readonly description: string
	/** The child's log, relative to the parent's session directory. */
	readonly path: string
	readonly batch?: { readonly batchId: string; readonly name: string; readonly phase?: string }
	/** `running` until the parent records `child_session_ended`, then the child's settled status. */
	readonly status: TurnExecutionStatus
	readonly stopReason?: string
	readonly tokens: number
	readonly costUsd: number
	readonly spawnedAt: string
	readonly endedAt?: string
	readonly session?: IndexedSession
}

/** A group of children spawned together, derived from `child_session_spawned.batch`. */
export interface IndexedBatch {
	readonly batchId: string
	readonly sessionId: SessionId
	readonly name: string
	/** The phase the most recent spawn named. */
	readonly phase?: string
	readonly agentsDone: number
	readonly agentsTotal: number
	readonly tokensTotal: number
}

/** One searchable part that matched. */
export interface EvidenceHit {
	readonly sessionId: SessionId
	readonly turnId?: TurnId
	readonly seq: number
	readonly part: number
	readonly source: string
	readonly toolName?: string
	readonly isError?: boolean
	/** UTF-16 position of the first match in the part's text. */
	readonly hit: number
	/** The text around the first match. */
	readonly excerpt: string
}

export interface EvidenceSearchOptions extends EvidenceQuery {
	readonly sessionId?: SessionId
	/** Defaults to 100. */
	readonly limit?: number
}

export interface ListSessionsOptions {
	readonly slug?: string
	/** Only sessions with no parent. */
	readonly rootsOnly?: boolean
	/** Defaults to true. */
	readonly includeArchived?: boolean
}

/**
 * How a log compares with its row: `fresh`, `grown` (appended since; the
 * index continues from its head), `truncated` or `rewritten` (the head record
 * no longer ends where it did or no longer hashes the same; the session is
 * re-derived), `unindexed` (no row yet) or `missing` (no file).
 */
export type SessionStaleness =
	| 'fresh'
	| 'grown'
	| 'truncated'
	| 'rewritten'
	| 'unindexed'
	| 'missing'

/** A log on disk, as the layout files it. */
export interface SessionLogLocation {
	readonly slug: string
	readonly logPath: string
	readonly sessionId: SessionId
}

export interface SessionIndex {
	readonly backend: 'sqlite' | 'scan'
	/** Derive (or continue deriving) one session from its records. */
	indexSession(input: SessionLogInput): Promise<IndexedSession | undefined>
	/** Compare one log with the index. */
	staleness(location: SessionLogLocation): Promise<SessionStaleness>
	/** Bring one session up to date with its log; returns what was found. */
	refresh(location: SessionLogLocation): Promise<SessionStaleness>
	/** Bring every session under `home` up to date and drop sessions whose log is gone. */
	sync(home: string): Promise<void>
	getSession(sessionId: SessionId): Promise<IndexedSession | undefined>
	listSessions(options?: ListSessionsOptions): Promise<IndexedSession[]>
	listTurns(sessionId: SessionId): Promise<IndexedTurn[]>
	listChildren(sessionId: SessionId): Promise<ChildSessionSummary[]>
	listPendingDecisions(options?: { sessionId?: SessionId }): Promise<IndexedPendingDecision[]>
	/** What a caller-side name refers to. The earliest claim wins when two sessions claim one name. */
	resolveExternal(
		protocol: string,
		kind: ExternalRefKind,
		externalId: string,
	): Promise<ExternalRefTarget | undefined>
	/** Every name one session holds, including those another session claimed first. */
	listExternalRefs(sessionId: SessionId): Promise<ExternalRefTarget[]>
	batches(options?: { sessionId?: SessionId }): Promise<IndexedBatch[]>
	searchEvidence(options: EvidenceSearchOptions): Promise<EvidenceHit[]>
	close(): void
}

export interface OpenSessionIndexOptions {
	/** Defaults to `resolveNamzuHome()`. */
	readonly home?: string
	/** Defaults to `<home>/index.sqlite`. */
	readonly path?: string
	/** `auto` (the default) uses SQLite when `node:sqlite` loads, the scan index otherwise. */
	readonly backend?: 'auto' | 'sqlite' | 'scan'
}

/**
 * Open the index for a home: a missing index, or one at another version, is
 * rebuilt from the logs; an existing one is brought up to date with them.
 */
export async function openSessionIndex(
	options: OpenSessionIndexOptions = {},
): Promise<SessionIndex> {
	const home = options.home ?? resolveNamzuHome()
	const backend = options.backend ?? 'auto'
	if (backend === 'scan' || (backend === 'auto' && !sqliteAvailable())) {
		return ScanSessionIndex.load(home)
	}
	return SqliteSessionIndex.open({ home, path: options.path ?? join(home, 'index.sqlite') })
}

export { EvidenceQueryError, evidenceMatcher, evidenceTexts, ftsMatchExpression } from './fts.js'
export type { EvidenceMatch, EvidenceQuery, EvidenceText } from './fts.js'
export { externalRefChanges, sessionRefKind } from './refs.js'
export type {
	ExternalRefChange,
	ExternalRefClaim,
	ExternalRefKind,
	ExternalRefTarget,
} from './refs.js'
export {
	SessionIndexError,
	discoverSessionLogs,
	readIndexableRecords,
} from './rebuild.js'
export type { IndexedLogPosition } from './rebuild.js'
export { ScanSessionIndex } from './scan.js'
export {
	SESSION_INDEX_VERSION,
	SqliteSessionIndex,
	rebuildSqliteSessionIndex,
	sqliteAvailable,
} from './sqlite.js'
export type { RebuildSqliteSessionIndexOptions, SqliteSessionIndexOptions } from './sqlite.js'
