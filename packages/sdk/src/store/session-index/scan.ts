import type { ProjectId, SessionId } from '../../types/ids/index.js'
import { evidenceMatcher } from './fts.js'
import type {
	ChildSessionSummary,
	EvidenceHit,
	EvidenceSearchOptions,
	IndexedBatch,
	IndexedPendingDecision,
	IndexedSession,
	IndexedTurn,
	ListSessionsOptions,
} from './index.js'
import {
	type BatchRow,
	type ChildRow,
	type DecisionRow,
	type EvidenceRow,
	type IndexSink,
	SessionIndexBase,
	type SessionRow,
	type TurnRow,
	batchView,
	childView,
	compareBy,
	decisionView,
	evidenceView,
	sessionView,
	turnView,
} from './rebuild.js'
import {
	type ExternalRefClaim,
	type ExternalRefKind,
	type ExternalRefTarget,
	claimTarget,
	compareClaims,
} from './refs.js'

const key = (...parts: string[]): string => parts.join('\u0000')

/**
 * The index without SQLite: the same rows, derived from the same records by
 * the same projection, held in memory for the life of the object.
 *
 * Used where `node:sqlite` does not load (Node 20, and Node 22 before 22.13).
 * {@link ScanSessionIndex.load} reads every log under a home; nothing is
 * written to disk, so each process derives its own copy.
 */
export class ScanSessionIndex extends SessionIndexBase {
	readonly backend = 'scan' as const
	readonly #sessions = new Map<string, SessionRow>()
	readonly #projects = new Map<string, { projectId: ProjectId; cwd: string }>()
	readonly #turns = new Map<string, TurnRow>()
	readonly #decisions = new Map<string, DecisionRow>()
	readonly #refs = new Map<string, ExternalRefClaim>()
	readonly #children = new Map<string, ChildRow>()
	readonly #batches = new Map<string, BatchRow>()
	readonly #evidence = new Map<string, EvidenceRow[]>()
	readonly #sink: IndexSink

	/** An empty index; fill it with `indexSession`, `refresh` or `sync`. */
	constructor() {
		super()
		const sessions = this.#sessions
		const turns = this.#turns
		const decisions = this.#decisions
		const refs = this.#refs
		const children = this.#children
		const batches = this.#batches
		const evidence = this.#evidence
		const projects = this.#projects
		const dropWhere = <T>(map: Map<string, T>, test: (row: T) => boolean) => {
			for (const [k, row] of map) if (test(row)) map.delete(k)
		}
		this.#sink = {
			getSession: (id) => sessions.get(id),
			putSession: (row) => {
				sessions.set(row.id, { ...row })
			},
			putProject: (slug, projectId, cwd) => {
				if (!projects.has(slug)) projects.set(slug, { projectId, cwd })
			},
			getTurn: (sessionId, turnId) => turns.get(key(sessionId, turnId)),
			putTurn: (row) => {
				turns.set(key(row.sessionId, row.id), { ...row })
			},
			putDecision: (row) => {
				decisions.set(key(row.sessionId, row.decisionId), { ...row })
			},
			deleteDecision: (sessionId, decisionId) => {
				decisions.delete(key(sessionId, decisionId))
			},
			deleteTurnDecisions: (sessionId, turnId) => {
				dropWhere(decisions, (row) => row.sessionId === sessionId && row.turnId === turnId)
			},
			claimRef: (claim) => {
				const k = key(claim.protocol, claim.kind, claim.externalId, claim.sessionId)
				if (!refs.has(k)) refs.set(k, { ...claim })
			},
			releaseRef: (protocol, kind, externalId, sessionId) => {
				refs.delete(key(protocol, kind, externalId, sessionId))
			},
			getChild: (sessionId, childId) => children.get(key(sessionId, childId)),
			putChild: (row) => {
				children.set(key(row.sessionId, row.childId), { ...row })
			},
			getBatch: (sessionId, batchId) => batches.get(key(sessionId, batchId)),
			putBatch: (row) => {
				batches.set(key(row.sessionId, row.batchId), { ...row })
			},
			putEvidence: (row) => {
				const rows = evidence.get(row.sessionId)
				if (rows === undefined) evidence.set(row.sessionId, [{ ...row }])
				else rows.push({ ...row })
			},
			clearSession: (sessionId) => {
				sessions.delete(sessionId)
				dropWhere(turns, (row) => row.sessionId === sessionId)
				dropWhere(decisions, (row) => row.sessionId === sessionId)
				dropWhere(refs, (row) => row.sessionId === sessionId)
				dropWhere(children, (row) => row.sessionId === sessionId)
				dropWhere(batches, (row) => row.sessionId === sessionId)
				evidence.delete(sessionId)
			},
		}
	}

	/** Derive the index for a home from every log under it. */
	static async load(home: string): Promise<ScanSessionIndex> {
		const index = new ScanSessionIndex()
		await index.sync(home)
		return index
	}

	/**
	 * One process, one event loop: the sink is only touched synchronously, so
	 * a unit of work cannot interleave with another. A failure part way leaves
	 * the rows it wrote; the next refresh of that log re-derives it.
	 */
	protected transaction<T>(work: (sink: IndexSink) => T): T {
		return work(this.#sink)
	}

	protected readSession(sessionId: SessionId): SessionRow | undefined {
		return this.#sessions.get(sessionId)
	}

	protected indexedSessionIds(): SessionId[] {
		return [...this.#sessions.keys()] as SessionId[]
	}

	async listSessions(options: ListSessionsOptions = {}): Promise<IndexedSession[]> {
		return [...this.#sessions.values()]
			.filter(
				(row) =>
					(options.slug === undefined || row.slug === options.slug) &&
					(options.rootsOnly !== true || row.parentId === null) &&
					(options.includeArchived !== false || !row.archived),
			)
			.sort(
				compareBy<SessionRow>(
					(row) => row.createdAt,
					(row) => row.id,
				),
			)
			.map(sessionView)
	}

	async listTurns(sessionId: SessionId): Promise<IndexedTurn[]> {
		return [...this.#turns.values()]
			.filter((row) => row.sessionId === sessionId)
			.sort(
				compareBy<TurnRow>(
					(row) => row.startedAt,
					(row) => row.id,
				),
			)
			.map(turnView)
	}

	async listChildren(sessionId: SessionId): Promise<ChildSessionSummary[]> {
		return [...this.#children.values()]
			.filter((row) => row.sessionId === sessionId)
			.sort(
				compareBy<ChildRow>(
					(row) => row.spawnedAt,
					(row) => row.childId,
				),
			)
			.map((row) => childView(row, this.#sessions.get(row.childId)))
	}

	async listPendingDecisions(
		options: { sessionId?: SessionId } = {},
	): Promise<IndexedPendingDecision[]> {
		return [...this.#decisions.values()]
			.filter((row) => options.sessionId === undefined || row.sessionId === options.sessionId)
			.sort(
				compareBy<DecisionRow>(
					(row) => row.sessionId,
					(row) => row.decisionId,
				),
			)
			.map(decisionView)
	}

	async resolveExternal(
		protocol: string,
		kind: ExternalRefKind,
		externalId: string,
	): Promise<ExternalRefTarget | undefined> {
		let best: ExternalRefClaim | undefined
		for (const claim of this.#refs.values()) {
			if (claim.protocol !== protocol || claim.kind !== kind || claim.externalId !== externalId)
				continue
			if (best === undefined || compareClaims(claim, best) < 0) best = claim
		}
		return best === undefined ? undefined : claimTarget(best)
	}

	async listExternalRefs(sessionId: SessionId): Promise<ExternalRefTarget[]> {
		return [...this.#refs.values()]
			.filter((claim) => claim.sessionId === sessionId)
			.sort(
				compareBy<ExternalRefClaim>(
					(claim) => claim.protocol,
					(claim) => claim.kind,
					(claim) => claim.externalId,
				),
			)
			.map(claimTarget)
	}

	async batches(options: { sessionId?: SessionId } = {}): Promise<IndexedBatch[]> {
		return [...this.#batches.values()]
			.filter((row) => options.sessionId === undefined || row.sessionId === options.sessionId)
			.sort(
				compareBy<BatchRow>(
					(row) => row.sessionId,
					(row) => row.batchId,
				),
			)
			.map(batchView)
	}

	async searchEvidence(options: EvidenceSearchOptions): Promise<EvidenceHit[]> {
		const match = evidenceMatcher(options)
		const limit = options.limit ?? 100
		const sessions =
			options.sessionId === undefined
				? [...this.#evidence.keys()].sort()
				: this.#evidence.has(options.sessionId)
					? [options.sessionId]
					: []
		const hits: EvidenceHit[] = []
		for (const sessionId of sessions) {
			const rows = [...(this.#evidence.get(sessionId) ?? [])].sort(
				compareBy<EvidenceRow>(
					(row) => row.seq,
					(row) => row.part,
				),
			)
			for (const row of rows) {
				const found = match(row.text)
				if (found === undefined) continue
				hits.push(evidenceView(row, found))
				if (hits.length >= limit) return hits
			}
		}
		return hits
	}

	close(): void {}
}
