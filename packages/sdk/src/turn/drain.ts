/**
 * One pass over a queue of durable turns: list what nobody holds, take it,
 * hand it to a worker, give it back.
 *
 * Every primitive this composes already exists — `SessionIndex` lists the
 * parked turns (`listPendingDecisions`) and the sessions whose turn is
 * still open, a session's lease arbitrates between processes, and
 * `resumeSession` carries the lease's fence into every record. This
 * composes them, so an approval inbox and a crash sweeper do not each have
 * to get the release into a `finally` and the `null` claim out of the error
 * path.
 *
 * ## What this deliberately is NOT
 *
 * A supervisor, a daemon, or a scheduler. There is no timer here, no
 * process spawn, no retry backoff and no `while (true)`. `drainParkedTurns` makes
 * ONE bounded pass and returns what happened; running it again is the
 * caller's decision, made wherever that caller already has a scheduler. A
 * per-platform supervisor is the same trade the deployment-adapter matrix
 * was rejected for: one seam beats N adapters.
 *
 * Read the scope of that narrowly. This paragraph has been cited as the
 * kernel's refusal of a model-facing "remind me tomorrow" capability, and
 * it is not one: it says a HOST brings the timer, which presumes the host
 * has one rather than ruling the capability out. Whether such a capability
 * should exist -- and if so, as a store plus a host-driven sweep rather
 * than a daemon here -- is open. `directory/types.ts` records the adjacent
 * decision that cut a declarative `schedules/` slot, on grounds of
 * double-fire and timezone; that is a different question from a runtime
 * tool, and neither text settles the other.
 *
 * The unit of work is a callback, so this module never needs a provider, a
 * tool registry or a sandbox — the half of a turn that cannot be serialized
 * stays with the caller, exactly as `resumeSession` already splits it.
 */

import { readParks } from '../runtime/query/checkpoint.js'
import type { SessionIndex } from '../store/session-index/index.js'
import { DiskSessionLog, type SessionLease, type SessionLog } from '../store/session-log/index.js'
import type { NamzuErrorCode } from '../types/errors/index.js'
import { NamzuError } from '../types/errors/index.js'
import type { CheckpointId, ProjectId, SessionId, TenantId, TurnId } from '../types/ids/index.js'
import type { DurableTurnEntry, ParkState, ParkSummary } from '../types/session/durable.js'

/** Turns handled per pass when the caller names no page size. */
export const DEFAULT_DRAIN_PAGE_SIZE = 100

/**
 * What a drainer does with one turn it successfully took.
 *
 * Receives the lease, not just its fence: the holder and expiry are what a
 * worker needs to decide whether it still has time to start. The intended
 * body is a resume under that lease:
 *
 * ```ts
 * onTurn: (entry, lease) =>
 *   resumeSession({ ...yourQueryParams, scope: { ...entry, topicId }, sessionLog, checkpointStore, lease })
 * ```
 *
 * A throw is recorded against that turn and the pass continues.
 */
export type DrainTurn = (entry: DurableTurnEntry, lease: SessionLease) => void | Promise<void>

export interface DrainTurnsParams {
	/** Where the durable turns are listed from. */
	readonly index: SessionIndex
	/** Attribution of every entry; the index is per `NAMZU_HOME`, which is per tenant. */
	readonly tenantId: TenantId
	/** Narrow to one project. */
	readonly projectId?: ProjectId
	/** Narrow to one session. */
	readonly sessionId?: SessionId
	/**
	 * Opens the log of a listed session. Default: the disk log at the path
	 * the index files it under.
	 */
	readonly openLog?: (sessionId: SessionId, logPath: string) => SessionLog
	/**
	 * Who is taking the turns. Per-PROCESS, never per-deployment: two drainers
	 * sharing a string would wait on each other's leases as their own.
	 */
	readonly holder: string
	/** Lease length in ms. Long enough that the slowest turn finishes inside it. */
	readonly ttlMs: number
	/** The work. See {@link DrainTurn}. */
	readonly onTurn: DrainTurn
	/**
	 * Keep only turns whose park is in one of these states.
	 *
	 * **Absent means every open turn nobody holds, parked or not**: what a
	 * crash sweep wants, because a turn that died mid-flight never parked. An
	 * approval inbox passes `['outstanding']`; a reclamation sweep passes
	 * `['expired']`.
	 */
	readonly park?: readonly ParkState[]
	/** Stop taking new turns. Work already in flight is not interrupted. */
	readonly signal?: AbortSignal
	/** How many turns may be in flight at once. Defaults to 1. */
	readonly maxConcurrent?: number
	/** Candidates handled per pass. See {@link DEFAULT_DRAIN_PAGE_SIZE}. */
	readonly pageSize?: number
	/** Clock for expiry, so one pass judges every lease and park against one instant. */
	readonly now?: number
}

/** A turn a pass could not finish, and why. */
export interface DrainFailure {
	readonly turnId: TurnId
	readonly error: string
}

/** What one pass did. */
export interface DrainTurnsResult {
	/** Candidates listed, before any of them were contended for. */
	readonly listed: number
	/** Turns whose `onTurn` returned. */
	readonly drained: readonly TurnId[]
	/** Turns whose session another worker held. Not failures. */
	readonly skipped: readonly TurnId[]
	/**
	 * Turns that stopped matching between the listing and the claim (another
	 * drainer finished them, or their park changed state), given straight back.
	 */
	readonly stale: readonly TurnId[]
	/** Turns whose `onTurn` threw. */
	readonly failed: readonly DrainFailure[]
	/** Turns that finished but whose lease could not be handed back. */
	readonly unreleased: readonly DrainFailure[]
	/** Whether the pass stopped early because the signal aborted. */
	readonly stopped: boolean
}

function refuse(code: NamzuErrorCode, message: string, details: Record<string, unknown>): never {
	throw new NamzuError({ code, message, details })
}

function toMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

interface Candidate {
	readonly sessionId: SessionId
	readonly projectId: ProjectId
	readonly logPath: string
}

/**
 * The durable facts of one open turn, from its session log: its checkpoints
 * (written and not pruned) and its newest park. `undefined` when the turn is
 * no longer the session's active turn.
 */
async function describeTurn(
	log: SessionLog,
	tenantId: TenantId,
	projectId: ProjectId,
	lease: SessionLease,
	now: number,
): Promise<DurableTurnEntry | undefined> {
	const active = await log.activeTurn({ lease, now })
	if (!active) return undefined
	const checkpoints = new Map<string, number>()
	for await (const { record } of log.read({ mode: 'tolerant' })) {
		if (record.type === 'checkpoint_written' && record.turnId === active.turnId) {
			checkpoints.set(record.checkpointId, Date.parse(record.ts))
		}
		if (record.type === 'checkpoint_pruned') {
			for (const id of record.checkpointIds) checkpoints.delete(id)
		}
	}
	const latest = [...checkpoints.entries()].at(-1)
	if (!latest) return undefined
	const park = (await readParks(log, { turnId: active.turnId })).at(-1)
	const summary: ParkSummary | undefined = park
		? {
				state:
					park.pending.resolvedAt !== undefined
						? 'resolved'
						: park.pending.deadlineAt !== undefined && now >= park.pending.deadlineAt
							? 'expired'
							: 'outstanding',
				checkpointId: park.checkpointId,
				requestType: park.pending.request.type,
				parkedAt: park.pending.parkedAt,
				...(park.pending.deadlineAt !== undefined ? { deadlineAt: park.pending.deadlineAt } : {}),
				...(park.pending.resolvedAt !== undefined ? { resolvedAt: park.pending.resolvedAt } : {}),
			}
		: undefined
	return {
		tenantId,
		projectId,
		sessionId: log.sessionId,
		turnId: active.turnId,
		turnCreatedAt: Date.parse(active.startedAt),
		checkpointCount: checkpoints.size,
		latestCheckpointId: latest[0] as CheckpointId,
		latestCheckpointAt: latest[1],
		...(summary ? { park: summary } : {}),
	}
}

/**
 * Take every open turn nobody holds, one bounded pass, and give each one
 * back when its work returns.
 *
 * The shape is: list → claim the session's lease → re-read the turn under
 * the lease → work → release in a `finally`. Only under the lease is the
 * re-read stable, and a turn that no longer matches (settled, resumed by
 * another drainer, or its park answered) is given straight back as
 * {@link DrainTurnsResult.stale}. An inbox drain whose work answers the park
 * is therefore exactly-once: doing the work removes the turn from the queue.
 *
 * @throws NamzuError `invalid_config` on a lease or concurrency that cannot
 *   mean what it says.
 */
export async function drainParkedTurns(params: DrainTurnsParams): Promise<DrainTurnsResult> {
	const { index, tenantId, holder, ttlMs, onTurn, park, signal } = params

	if (holder.trim().length === 0) {
		refuse(
			'invalid_config',
			'drainParkedTurns: `holder` is empty. Use something per-process — a worker id, a pod name plus a pid.',
			{ holder },
		)
	}
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
		refuse(
			'invalid_config',
			`drainParkedTurns: ttlMs must be a positive number of milliseconds, got ${String(ttlMs)}. A lease that expires immediately is a lease every worker can take at once.`,
			{ ttlMs },
		)
	}
	const maxConcurrent = params.maxConcurrent ?? 1
	if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
		refuse(
			'invalid_config',
			`drainParkedTurns: maxConcurrent must be a positive integer, got ${String(params.maxConcurrent)}.`,
			{ maxConcurrent: params.maxConcurrent },
		)
	}
	const pageSize = params.pageSize ?? DEFAULT_DRAIN_PAGE_SIZE
	const openLog =
		params.openLog ??
		((sessionId: SessionId, logPath: string) =>
			new DiskSessionLog({ sessionId, file: logPath, sessionDir: logPath.replace(/\.jsonl$/, '') }))

	const drained: TurnId[] = []
	const skipped: TurnId[] = []
	const stale: TurnId[] = []
	const failed: DrainFailure[] = []
	const unreleased: DrainFailure[] = []
	let stopped = false

	// Candidates: sessions with an unresolved decision, and — with no park
	// filter — every session whose turn is still open (running, paused or
	// interrupted); a running one is held, and its claim below is refused.
	const sessions = new Map<SessionId, Candidate>()
	const pending = await index.listPendingDecisions(
		params.sessionId ? { sessionId: params.sessionId } : {},
	)
	const consider = async (sessionId: SessionId): Promise<void> => {
		if (sessions.has(sessionId)) return
		const session = await index.getSession(sessionId)
		if (!session) return
		if (params.projectId && session.projectId !== params.projectId) return
		sessions.set(sessionId, { sessionId, projectId: session.projectId, logPath: session.logPath })
	}
	for (const decision of pending) await consider(decision.sessionId)
	if (!park) {
		for (const session of await index.listSessions()) {
			if (params.sessionId && session.id !== params.sessionId) continue
			if (session.status !== 'idle') await consider(session.id)
		}
	}
	const candidates = [...sessions.values()].slice(0, pageSize)

	const handle = async (candidate: Candidate): Promise<void> => {
		const log = openLog(candidate.sessionId, candidate.logPath)
		const now = params.now ?? Date.now()
		const lease = await log.claim({ holder, ttlMs, now })
		const active = await log.activeTurn()
		const turnId = active?.turnId ?? ('' as TurnId)
		if (!lease) {
			if (active) skipped.push(active.turnId)
			return
		}
		let entry: DurableTurnEntry | undefined
		try {
			entry = await describeTurn(log, tenantId, candidate.projectId, lease, now)
		} catch (err) {
			failed.push({ turnId, error: toMessage(err) })
		}
		const matches =
			entry !== undefined &&
			(!park || (entry.park !== undefined && park.includes(entry.park.state)))
		try {
			if (!entry || !matches) {
				if (entry || active) stale.push(entry?.turnId ?? turnId)
				return
			}
			try {
				await onTurn(entry, lease)
				drained.push(entry.turnId)
			} catch (err) {
				failed.push({ turnId: entry.turnId, error: toMessage(err) })
			}
		} finally {
			try {
				await log.release(lease)
			} catch (err) {
				unreleased.push({ turnId: entry?.turnId ?? turnId, error: toMessage(err) })
			}
		}
	}

	for (let i = 0; i < candidates.length; i += maxConcurrent) {
		if (signal?.aborted) {
			stopped = true
			break
		}
		await Promise.all(candidates.slice(i, i + maxConcurrent).map(handle))
	}

	return { listed: candidates.length, drained, skipped, stale, failed, unreleased, stopped }
}
