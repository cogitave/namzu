import { type Dirent, constants as fsConstants } from 'node:fs'
import { type FileHandle, open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSessionLogLine, recordSha256 } from '../../session/log-hash.js'
import type { ProjectId, SessionId, TurnId } from '../../types/ids/index.js'
import { SESSION_RECORD_MAX_BYTES, type SessionRecord } from '../../types/session/records.js'
import type { TurnExecutionStatus } from '../../types/session/turn.js'
import { isEntityId } from '../../utils/id.js'
import { evidenceTexts } from './fts.js'
import type {
	ChildSessionSummary,
	EvidenceHit,
	EvidenceSearchOptions,
	IndexableRecord,
	IndexedBatch,
	IndexedPendingDecision,
	IndexedSession,
	IndexedSessionStatus,
	IndexedTurn,
	IndexedTurnStatus,
	ListSessionsOptions,
	SessionIndex,
	SessionLogInput,
	SessionLogLocation,
	SessionStaleness,
} from './index.js'
import {
	type ExternalRefClaim,
	type ExternalRefKind,
	type ExternalRefTarget,
	externalRefChanges,
} from './refs.js'

/**
 * Deriving the index from the logs: reading a log's records, finding every
 * log under a home, and the one projection from records to rows that both
 * backends share. A full rebuild and an incremental update run the same
 * projection over the same records, which is why they agree.
 */

export class SessionIndexError extends Error {
	override readonly name = 'SessionIndexError'
}

// ─── reading a log ─────────────────────────────────────────────────────────

/** The indexed head of a log: where reading continues. */
export interface IndexedLogPosition {
	/** Bytes already read: the end of the head record. */
	readonly offset: number
	readonly seq: number
	readonly sha256: string
}

const READ_CHUNK = 1024 * 1024
const NEWLINE = 0x0a

/**
 * Read a session log's records in order, each with its pointer, from the
 * start or from an indexed head.
 *
 * A tolerant read: it stops, without throwing, at the first line that is torn,
 * does not parse, or breaks the chain (a seq out of order, or a `prev` that
 * does not name the line before it). What it yields is always an intact
 * prefix. Repairing the log is the log's own business, not the index's.
 */
export async function* readIndexableRecords(
	path: string,
	from?: IndexedLogPosition,
): AsyncGenerator<IndexableRecord> {
	const handle = await open(path, fsConstants.O_RDONLY)
	try {
		let offset = from?.offset ?? 0
		let position = offset
		let expectedSeq = (from?.seq ?? 0) + 1
		let previous: { seq: number; offset: number; length: number; sha256: string } | undefined
		let sessionId: string | undefined
		let carry = Buffer.alloc(0)
		const chunk = Buffer.alloc(READ_CHUNK)
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK, position)
			if (bytesRead === 0) return
			position += bytesRead
			const data =
				carry.length === 0
					? chunk.subarray(0, bytesRead)
					: Buffer.concat([carry, chunk.subarray(0, bytesRead)])
			let start = 0
			for (let end = data.indexOf(NEWLINE, start); end !== -1; end = data.indexOf(NEWLINE, start)) {
				let record: SessionRecord
				let length: number
				let sha256: string
				try {
					const parsed = parseSessionLogLine(data.subarray(start, end + 1))
					record = parsed.record
					length = parsed.length
					sha256 = parsed.sha256
				} catch {
					return
				}
				if (record.seq !== expectedSeq) return
				if (sessionId !== undefined && record.sessionId !== sessionId) return
				const prev = record.prev
				if (previous !== undefined) {
					if (
						prev === null ||
						prev.seq !== previous.seq ||
						prev.offset !== previous.offset ||
						prev.length !== previous.length ||
						prev.sha256 !== previous.sha256
					)
						return
				} else if (from !== undefined) {
					if (
						prev === null ||
						prev.seq !== from.seq ||
						prev.sha256 !== from.sha256 ||
						prev.offset + prev.length !== from.offset
					)
						return
				} else if (prev !== null || offset !== 0) return
				const pointer = { seq: record.seq, offset, length, sha256 }
				yield { record, pointer }
				sessionId = record.sessionId
				previous = pointer
				offset += length
				expectedSeq += 1
				start = end + 1
			}
			carry = Buffer.from(data.subarray(start))
			if (carry.length > SESSION_RECORD_MAX_BYTES) return
		}
	} finally {
		await handle.close()
	}
}

/**
 * The SHA-256 of the line that ends exactly at `end`, or `undefined` when no
 * complete line ends there (the byte before `end` is not a newline).
 */
async function hashOfLineEndingAt(handle: FileHandle, end: number): Promise<string | undefined> {
	if (end <= 0) return undefined
	let window = Math.min(end, 64 * 1024)
	for (;;) {
		const buffer = Buffer.alloc(window)
		const { bytesRead } = await handle.read(buffer, 0, window, end - window)
		if (bytesRead !== window || buffer[window - 1] !== NEWLINE) return undefined
		const previousNewline = buffer.lastIndexOf(NEWLINE, window - 2)
		if (previousNewline !== -1) return recordSha256(buffer.subarray(previousNewline + 1))
		if (window === end) return recordSha256(buffer)
		if (window >= SESSION_RECORD_MAX_BYTES) return undefined
		window = Math.min(end, window * 4)
	}
}

// ─── finding the logs ──────────────────────────────────────────────────────

const SLUG = /^[A-Za-z0-9-]+$/

async function entries(dir: string): Promise<Dirent[]> {
	try {
		return await readdir(dir, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
}

async function collectLogs(
	dir: string,
	slug: string,
	found: SessionLogLocation[],
	depth: number,
): Promise<void> {
	const list = await entries(dir)
	for (const entry of list) {
		if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
		const sessionId = entry.name.slice(0, -'.jsonl'.length)
		if (!isEntityId(sessionId, 'session')) continue
		found.push({ slug, logPath: join(dir, entry.name), sessionId: sessionId as SessionId })
		// Child logs live under <session-id>/subagents/, to any depth.
		if (depth < 64) {
			await collectLogs(join(dir, sessionId, 'subagents'), slug, found, depth + 1)
		}
	}
}

/**
 * Every session log under `home`: `projects/<slug>/<session-id>.jsonl` and,
 * recursively, `<session-id>/subagents/<child-id>.jsonl`.
 *
 * A directory under `projects/` whose name is a UUID is the old layout
 * (`legacy`) and is never read; a new slug can never look like one.
 */
export async function discoverSessionLogs(home: string): Promise<SessionLogLocation[]> {
	const found: SessionLogLocation[] = []
	const projects = join(home, 'projects')
	for (const entry of await entries(projects)) {
		if (!entry.isDirectory() || !SLUG.test(entry.name) || isEntityId(entry.name, 'session'))
			continue
		await collectLogs(join(projects, entry.name), entry.name, found, 0)
	}
	found.sort((a, b) => (a.logPath < b.logPath ? -1 : a.logPath > b.logPath ? 1 : 0))
	return found
}

// ─── rows ──────────────────────────────────────────────────────────────────

export interface SessionRow {
	id: SessionId
	slug: string
	projectId: ProjectId
	parentId: SessionId | null
	rootId: SessionId
	depth: number
	title: string | null
	archived: boolean
	status: IndexedSessionStatus
	createdAt: string
	updatedAt: string
	logPath: string
	logBytes: number
	headSeq: number
	headSha256: string
}

export interface TurnRow {
	id: TurnId
	sessionId: SessionId
	status: IndexedTurnStatus
	stopReason: string | null
	startedAt: string
	endedAt: string | null
	tokens: number
	costUsd: number
	userPreview: string | null
	originKind: string | null
}

export interface DecisionRow {
	decisionId: string
	sessionId: SessionId
	turnId: TurnId
	checkpointId: string
	deadlineAt: string | null
}

export interface ChildRow {
	sessionId: SessionId
	childId: SessionId
	turnId: TurnId
	toolCallId: string
	kind: string
	description: string
	path: string
	batchId: string | null
	batchName: string | null
	batchPhase: string | null
	status: TurnExecutionStatus
	stopReason: string | null
	tokens: number
	costUsd: number
	spawnedAt: string
	endedAt: string | null
}

export interface BatchRow {
	batchId: string
	sessionId: SessionId
	name: string
	phase: string | null
	agentsDone: number
	agentsTotal: number
	tokensTotal: number
}

export interface EvidenceRow {
	sessionId: SessionId
	turnId: TurnId | null
	seq: number
	part: number
	source: string
	toolName: string | null
	isError: boolean | null
	text: string
}

/**
 * The writes and reads the projection needs, inside one transaction. The
 * SQLite backend runs them as statements, the scan backend on maps.
 */
export interface IndexSink {
	getSession(id: SessionId): SessionRow | undefined
	putSession(row: SessionRow): void
	putProject(slug: string, projectId: ProjectId, cwd: string): void
	getTurn(sessionId: SessionId, turnId: TurnId): TurnRow | undefined
	putTurn(row: TurnRow): void
	putDecision(row: DecisionRow): void
	deleteDecision(sessionId: SessionId, decisionId: string): void
	deleteTurnDecisions(sessionId: SessionId, turnId: TurnId): void
	/** Records a claim unless the session already claims that name. */
	claimRef(claim: ExternalRefClaim): void
	releaseRef(
		protocol: string,
		kind: ExternalRefKind,
		externalId: string,
		sessionId: SessionId,
	): void
	getChild(sessionId: SessionId, childId: SessionId): ChildRow | undefined
	putChild(row: ChildRow): void
	getBatch(sessionId: SessionId, batchId: string): BatchRow | undefined
	putBatch(row: BatchRow): void
	putEvidence(row: EvidenceRow): void
	/** Removes every row derived from one session's log. */
	clearSession(sessionId: SessionId): void
}

const PREVIEW_CHARS = 200

function messageText(content: unknown): string {
	if (content === null || typeof content !== 'object') return ''
	const body = (content as { content?: unknown }).content
	if (typeof body === 'string') return body
	if (Array.isArray(body)) {
		return body
			.map((part) =>
				part !== null &&
				typeof part === 'object' &&
				typeof (part as { text?: unknown }).text === 'string'
					? (part as { text: string }).text
					: '',
			)
			.join('')
	}
	return ''
}

function withStatus(session: SessionRow, status: IndexedSessionStatus): SessionRow {
	return session.status === status ? session : { ...session, status }
}

/**
 * Apply one record to the rows. `session` is the row before the record (or
 * `undefined` for `session_started`); the row after is returned and the
 * caller stores it.
 */
function applyRecord(
	sink: IndexSink,
	location: { slug: string; logPath: string },
	session: SessionRow | undefined,
	{ record, pointer }: IndexableRecord,
): SessionRow {
	let row: SessionRow
	if (record.type === 'session_started') {
		sink.putProject(location.slug, record.projectId, record.cwd)
		row = {
			id: record.sessionId,
			slug: location.slug,
			projectId: record.projectId,
			parentId: record.parent?.sessionId ?? null,
			rootId: record.parent?.rootSessionId ?? record.sessionId,
			depth: record.parent?.depth ?? 0,
			title: null,
			archived: false,
			status: 'idle',
			createdAt: record.ts,
			updatedAt: record.ts,
			logPath: location.logPath,
			logBytes: 0,
			headSeq: 0,
			headSha256: '',
		}
	} else if (session === undefined) {
		throw new SessionIndexError(
			`Session ${record.sessionId} has no session_started in the index; index it from seq 1.`,
		)
	} else {
		row = session
	}
	const sessionId = row.id

	switch (record.type) {
		case 'session_updated':
			row = {
				...row,
				...(record.title === undefined ? {} : { title: record.title }),
				...(record.archived === undefined ? {} : { archived: record.archived }),
			}
			break
		case 'turn_started':
			sink.putTurn({
				id: record.turnId,
				sessionId,
				status: 'running',
				stopReason: null,
				startedAt: record.ts,
				endedAt: null,
				tokens: 0,
				costUsd: 0,
				userPreview: null,
				originKind: record.origin?.kind ?? null,
			})
			row = withStatus(row, 'running')
			break
		case 'turn_paused':
		case 'turn_resuming': {
			const turn = sink.getTurn(sessionId, record.turnId)
			const status = record.type === 'turn_paused' ? 'paused' : 'running'
			if (turn !== undefined) sink.putTurn({ ...turn, status })
			row = withStatus(row, status)
			break
		}
		case 'turn_completed':
		case 'turn_failed': {
			const turn = sink.getTurn(sessionId, record.turnId)
			if (turn !== undefined) {
				sink.putTurn({
					...turn,
					status:
						record.type === 'turn_failed'
							? 'failed'
							: record.settlement.status === 'cancelled'
								? 'cancelled'
								: 'completed',
					stopReason: record.type === 'turn_completed' ? (record.stopReason ?? null) : null,
					endedAt: record.ts,
					tokens: record.settlement.usage.totalTokens,
					costUsd: record.settlement.cost.totalCost,
				})
			}
			// A closed turn waits on nothing: an abandoned turn's open decisions close with it.
			sink.deleteTurnDecisions(sessionId, record.turnId)
			row = withStatus(row, 'idle')
			break
		}
		case 'message': {
			if (record.role === 'user' && (record.kind === undefined || record.kind === 'prompt')) {
				const turn = sink.getTurn(sessionId, record.turnId)
				if (turn !== undefined && turn.userPreview === null) {
					sink.putTurn({
						...turn,
						userPreview: messageText(record.content).slice(0, PREVIEW_CHARS),
					})
				}
			}
			break
		}
		case 'decision_requested':
			sink.putDecision({
				decisionId: record.decisionId,
				sessionId,
				turnId: record.turnId,
				checkpointId: record.checkpointId,
				deadlineAt: record.deadlineAt ?? null,
			})
			break
		case 'decision_resolved':
		case 'decision_expired':
			sink.deleteDecision(sessionId, record.decisionId)
			break
		case 'child_session_spawned': {
			if (sink.getChild(sessionId, record.childSessionId) !== undefined) break
			const batch = record.batch
			sink.putChild({
				sessionId,
				childId: record.childSessionId,
				turnId: record.turnId,
				toolCallId: record.toolCallId,
				kind: record.kind,
				description: record.description,
				path: record.path,
				batchId: batch?.batchId ?? null,
				batchName: batch?.name ?? null,
				batchPhase: batch?.phase ?? null,
				status: 'running',
				stopReason: null,
				tokens: 0,
				costUsd: 0,
				spawnedAt: record.ts,
				endedAt: null,
			})
			if (batch !== undefined) {
				const existing = sink.getBatch(sessionId, batch.batchId)
				sink.putBatch({
					batchId: batch.batchId,
					sessionId,
					name: batch.name,
					phase: batch.phase ?? existing?.phase ?? null,
					agentsDone: existing?.agentsDone ?? 0,
					agentsTotal: (existing?.agentsTotal ?? 0) + 1,
					tokensTotal: existing?.tokensTotal ?? 0,
				})
			}
			break
		}
		case 'child_session_ended': {
			const child = sink.getChild(sessionId, record.childSessionId)
			if (child === undefined || child.endedAt !== null) break
			const tokens = record.usage.totalTokens
			sink.putChild({
				...child,
				status: record.status,
				stopReason: record.stopReason ?? null,
				tokens,
				costUsd: record.cost.totalCost,
				endedAt: record.ts,
			})
			if (child.batchId !== null) {
				const batch = sink.getBatch(sessionId, child.batchId)
				if (batch !== undefined) {
					sink.putBatch({
						...batch,
						agentsDone: batch.agentsDone + 1,
						tokensTotal: batch.tokensTotal + tokens,
					})
				}
			}
			break
		}
		default:
			break
	}

	for (const change of externalRefChanges(record)) {
		if (change.op === 'claim') sink.claimRef(change.claim)
		else sink.releaseRef(change.protocol, change.kind, change.externalId, change.sessionId)
	}

	for (const text of evidenceTexts(record)) {
		sink.putEvidence({
			sessionId,
			turnId: record.turnId ?? null,
			seq: record.seq,
			part: text.part,
			source: text.source,
			toolName: text.toolName ?? null,
			isError: text.isError ?? null,
			text: text.text,
		})
	}

	return {
		...row,
		updatedAt: record.ts,
		logBytes: pointer.offset + pointer.length,
		headSeq: pointer.seq,
		headSha256: pointer.sha256,
	}
}

// ─── row views ─────────────────────────────────────────────────────────────

export function sessionView(row: SessionRow): IndexedSession {
	return {
		id: row.id,
		slug: row.slug,
		projectId: row.projectId,
		...(row.parentId === null ? {} : { parentId: row.parentId }),
		rootId: row.rootId,
		depth: row.depth,
		...(row.title === null ? {} : { title: row.title }),
		archived: row.archived,
		status: row.status,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		logPath: row.logPath,
		logBytes: row.logBytes,
		headSeq: row.headSeq,
		headSha256: row.headSha256,
	}
}

export function turnView(row: TurnRow): IndexedTurn {
	return {
		id: row.id,
		sessionId: row.sessionId,
		status: row.status,
		...(row.stopReason === null ? {} : { stopReason: row.stopReason }),
		startedAt: row.startedAt,
		...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
		tokens: row.tokens,
		costUsd: row.costUsd,
		...(row.userPreview === null ? {} : { userPreview: row.userPreview }),
		...(row.originKind === null ? {} : { originKind: row.originKind }),
	}
}

export function decisionView(row: DecisionRow): IndexedPendingDecision {
	return {
		decisionId: row.decisionId,
		sessionId: row.sessionId,
		turnId: row.turnId,
		checkpointId: row.checkpointId,
		...(row.deadlineAt === null ? {} : { deadlineAt: row.deadlineAt }),
	}
}

export function childView(row: ChildRow, session: SessionRow | undefined): ChildSessionSummary {
	return {
		sessionId: row.childId,
		parentSessionId: row.sessionId,
		parentTurnId: row.turnId,
		toolCallId: row.toolCallId,
		kind: row.kind,
		description: row.description,
		path: row.path,
		...(row.batchId === null
			? {}
			: {
					batch: {
						batchId: row.batchId,
						name: row.batchName ?? '',
						...(row.batchPhase === null ? {} : { phase: row.batchPhase }),
					},
				}),
		status: row.status,
		...(row.stopReason === null ? {} : { stopReason: row.stopReason }),
		tokens: row.tokens,
		costUsd: row.costUsd,
		spawnedAt: row.spawnedAt,
		...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
		...(session === undefined ? {} : { session: sessionView(session) }),
	}
}

export function batchView(row: BatchRow): IndexedBatch {
	return {
		batchId: row.batchId,
		sessionId: row.sessionId,
		name: row.name,
		...(row.phase === null ? {} : { phase: row.phase }),
		agentsDone: row.agentsDone,
		agentsTotal: row.agentsTotal,
		tokensTotal: row.tokensTotal,
	}
}

export function evidenceView(
	row: EvidenceRow,
	match: { hit: number; start: number; end: number },
): EvidenceHit {
	return {
		sessionId: row.sessionId,
		...(row.turnId === null ? {} : { turnId: row.turnId }),
		seq: row.seq,
		part: row.part,
		source: row.source,
		...(row.toolName === null ? {} : { toolName: row.toolName }),
		...(row.isError === null ? {} : { isError: row.isError }),
		hit: match.hit,
		excerpt: row.text.slice(match.start, match.end),
	}
}

/** Ascending by the given keys, compared as strings or numbers. */
export function compareBy<T>(...keys: ((row: T) => string | number)[]): (a: T, b: T) => number {
	return (a, b) => {
		for (const key of keys) {
			const x = key(a)
			const y = key(b)
			if (x !== y) return x < y ? -1 : 1
		}
		return 0
	}
}

// ─── the shared index logic ────────────────────────────────────────────────

/** Records applied per transaction: short enough to let other writers in, long enough to be cheap. */
const RECORDS_PER_TRANSACTION = 256

/**
 * Everything both backends share: indexing records, comparing a log with the
 * index, refreshing and syncing. A backend supplies the transaction, the sink
 * and the queries.
 */
export abstract class SessionIndexBase implements SessionIndex {
	abstract readonly backend: 'sqlite' | 'scan'

	/** Run `work` in one write transaction (`BEGIN IMMEDIATE` in SQLite). */
	protected abstract transaction<T>(work: (sink: IndexSink) => T): T
	protected abstract readSession(sessionId: SessionId): SessionRow | undefined
	protected abstract indexedSessionIds(): SessionId[]

	abstract listSessions(options?: ListSessionsOptions): Promise<IndexedSession[]>
	abstract listTurns(sessionId: SessionId): Promise<IndexedTurn[]>
	abstract listChildren(sessionId: SessionId): Promise<ChildSessionSummary[]>
	abstract listPendingDecisions(options?: { sessionId?: SessionId }): Promise<
		IndexedPendingDecision[]
	>
	abstract resolveExternal(
		protocol: string,
		kind: ExternalRefKind,
		externalId: string,
	): Promise<ExternalRefTarget | undefined>
	abstract listExternalRefs(sessionId: SessionId): Promise<ExternalRefTarget[]>
	abstract batches(options?: { sessionId?: SessionId }): Promise<IndexedBatch[]>
	abstract searchEvidence(options: EvidenceSearchOptions): Promise<EvidenceHit[]>
	abstract close(): void

	async getSession(sessionId: SessionId): Promise<IndexedSession | undefined> {
		const row = this.readSession(sessionId)
		return row === undefined ? undefined : sessionView(row)
	}

	async indexSession(input: SessionLogInput): Promise<IndexedSession | undefined> {
		const location = { slug: input.slug, logPath: input.logPath }
		let batch: IndexableRecord[] = []
		let first = true
		let sessionId: SessionId | undefined
		/** The head this writer expects the row to have before its next batch. */
		let expected: { seq: number; sha256: string } | undefined

		const flush = (): boolean => {
			const records = batch
			batch = []
			if (records.length === 0) return true
			return this.transaction((sink) => {
				const head = records[0] as IndexableRecord
				let row = sink.getSession(head.record.sessionId)
				if (first && head.record.seq === 1) {
					sink.clearSession(head.record.sessionId)
					row = undefined
				} else if (
					row === undefined ||
					row.headSeq !== head.record.seq - 1 ||
					head.record.prev === null ||
					head.record.prev.sha256 !== row.headSha256 ||
					head.record.prev.offset + head.record.prev.length !== row.logBytes
				) {
					if (first) {
						throw new SessionIndexError(
							`The records for session ${head.record.sessionId} start at seq ${head.record.seq}, which does not continue the indexed head (seq ${row?.headSeq ?? 0}).`,
						)
					}
					return false
				} else if (
					expected !== undefined &&
					(row.headSeq !== expected.seq || row.headSha256 !== expected.sha256)
				) {
					return false
				}
				first = false
				for (const item of records) row = applyRecord(sink, location, row, item)
				if (row !== undefined) {
					row = { ...row, slug: location.slug, logPath: location.logPath }
					sink.putSession(row)
					expected = { seq: row.headSeq, sha256: row.headSha256 }
				}
				return true
			})
		}

		let previous: IndexableRecord | undefined
		for await (const item of input.records) {
			const { record, pointer } = item
			sessionId ??= record.sessionId
			if (record.sessionId !== sessionId) {
				throw new SessionIndexError(
					`Record seq ${record.seq} belongs to session ${record.sessionId}, not ${sessionId}.`,
				)
			}
			if (pointer.seq !== record.seq) {
				throw new SessionIndexError(`Record seq ${record.seq} has a pointer to seq ${pointer.seq}.`)
			}
			if (previous !== undefined) {
				const prev = record.prev
				if (
					record.seq !== previous.record.seq + 1 ||
					prev === null ||
					prev.seq !== previous.pointer.seq ||
					prev.offset !== previous.pointer.offset ||
					prev.length !== previous.pointer.length ||
					prev.sha256 !== previous.pointer.sha256
				) {
					throw new SessionIndexError(
						`Record seq ${record.seq} of session ${sessionId} does not chain to seq ${previous.record.seq}.`,
					)
				}
			}
			previous = item
			batch.push(item)
			if (batch.length >= RECORDS_PER_TRANSACTION && !flush()) {
				// Another writer advanced this session past us; its rows are the same records'.
				return this.getSession(sessionId)
			}
		}
		flush()
		return sessionId === undefined ? undefined : this.getSession(sessionId)
	}

	async staleness(location: SessionLogLocation): Promise<SessionStaleness> {
		let handle: FileHandle
		try {
			handle = await open(location.logPath, fsConstants.O_RDONLY)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
			throw error
		}
		try {
			const row = this.readSession(location.sessionId)
			if (row === undefined) return 'unindexed'
			const { size } = await handle.stat()
			if (size < row.logBytes) return 'truncated'
			if ((await hashOfLineEndingAt(handle, row.logBytes)) !== row.headSha256) return 'rewritten'
			return size > row.logBytes ? 'grown' : 'fresh'
		} finally {
			await handle.close()
		}
	}

	async refresh(location: SessionLogLocation): Promise<SessionStaleness> {
		const state = await this.staleness(location)
		if (state === 'fresh') return state
		if (state === 'missing') {
			this.transaction((sink) => sink.clearSession(location.sessionId))
			return state
		}
		const row = state === 'grown' ? this.readSession(location.sessionId) : undefined
		const from =
			row === undefined
				? undefined
				: { offset: row.logBytes, seq: row.headSeq, sha256: row.headSha256 }
		const indexed = await this.indexSession({
			slug: location.slug,
			logPath: location.logPath,
			records: readIndexableRecords(location.logPath, from),
		})
		// A log re-read from the start that yields no intact record keeps no rows.
		if (indexed === undefined && from === undefined) {
			this.transaction((sink) => sink.clearSession(location.sessionId))
		}
		return state
	}

	async sync(home: string): Promise<void> {
		const logs = await discoverSessionLogs(home)
		const present = new Set<string>()
		for (const log of logs) {
			present.add(log.sessionId)
			await this.refresh(log)
		}
		const gone = this.indexedSessionIds().filter((id) => !present.has(id))
		if (gone.length > 0) {
			this.transaction((sink) => {
				for (const id of gone) sink.clearSession(id)
			})
		}
	}
}

/** Whether a path exists; any error other than ENOENT is thrown. */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
		throw error
	}
}
