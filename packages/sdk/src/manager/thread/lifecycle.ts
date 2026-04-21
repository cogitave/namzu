/**
 * ThreadManager — thin orchestrator over {@link ThreadStore} and
 * {@link SessionStore}.
 *
 * Owns user-facing lifecycle operations on the Thread topic layer plus the
 * archive-gate contract enforced at session-creation ingress sites.
 *
 * Phase 2.6 wired `ThreadManager.requireOpen` into three ingress paths:
 *   - {@link AgentManager.provisionSpawn} (child session creation)
 *   - `executeSingleHandoff` (recipient session creation)
 *   - `executeBroadcastHandoff` (N recipient sessions per fan-out)
 * Those call sites depend on this manager, so the one-method indirection
 * stopped being "structural overhead" the moment archive/delete needed the
 * session-presence cross-check anyway.
 *
 * Archive + delete require cross-store preconditions (session-presence
 * checks) — enforced here where both stores are in scope. The stores
 * themselves stay unaware of each other's layout (Convention #0), which is
 * why the gate lives at the manager layer rather than as a universal store
 * interceptor (see `archive` JSDoc for the direct-store-bypass boundary).
 */

import {
	THREAD_NOT_EMPTY_SAMPLE_LIMIT,
	ThreadClosedError,
	ThreadNotEmptyError,
} from '../../session/errors.js'
import type { TenantId } from '../../types/ids/index.js'
import type { Session, SessionStatus } from '../../types/session/entity.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import type { SessionStore } from '../../types/session/store.js'
import type { Thread } from '../../types/thread/entity.js'
import type { CreateThreadParams, ThreadStore } from '../../types/thread/store.js'

export interface ThreadManagerDeps {
	readonly threadStore: ThreadStore
	readonly sessionStore: SessionStore
}

/**
 * Session statuses that block Thread archival. A session in any of these
 * states has live work in-flight (mid-run, mid-handoff, blocked on human
 * input, or orchestrating a broadcast merge) — freezing the Thread while any
 * of them are active would strand resumable work.
 *
 * `idle`, `failed`, and `archived` are archival-compatible: they are
 * quiescent or already-terminal, so a newly-frozen Thread can safely contain
 * them. This list mirrors the `SessionStatus` discriminants that represent
 * "not-yet-done" work (session-hierarchy.md §5.1).
 */
const ARCHIVAL_BLOCKING_STATUSES: ReadonlySet<SessionStatus> = new Set([
	'active',
	'locked',
	'awaiting_hitl',
	'awaiting_merge',
])

export class ThreadManager {
	private readonly deps: ThreadManagerDeps

	constructor(deps: ThreadManagerDeps) {
		this.deps = deps
	}

	/** Persist a new Thread. Thin passthrough for uniformity at the manager surface. */
	create(params: CreateThreadParams, tenantId: TenantId): Promise<Thread> {
		return this.deps.threadStore.createThread(params, tenantId)
	}

	/** Read a Thread by id; returns `null` when absent for the tenant. */
	get(threadId: ThreadId, tenantId: TenantId): Promise<Thread | null> {
		return this.deps.threadStore.getThread(threadId, tenantId)
	}

	/**
	 * CAS update on a Thread. Propagates {@link import('../../session/errors.js').StaleThreadError}
	 * from the store on `ownerVersion` mismatch — callers re-read, re-apply,
	 * and retry.
	 */
	update(thread: Thread, tenantId: TenantId): Promise<void> {
		return this.deps.threadStore.updateThread(thread, tenantId)
	}

	/** List Threads under a Project, ordered by `createdAt` ascending. */
	list(projectId: ProjectId, tenantId: TenantId): Promise<readonly Thread[]> {
		return this.deps.threadStore.listThreads(projectId, tenantId)
	}

	/**
	 * Load a Thread and assert it is in `'open'` state. Used by the spawn path
	 * as a precondition — a SubSession cannot be created under an archived
	 * Thread. Throws on absence and on archival; returns the loaded Thread on
	 * success so callers can avoid the second round-trip.
	 *
	 * Convention #5: deny-by-default. A missing Thread is a hard error, not a
	 * silent "assume archived".
	 */
	async requireOpen(threadId: ThreadId, tenantId: TenantId): Promise<Thread> {
		const thread = await this.deps.threadStore.getThread(threadId, tenantId)
		if (!thread) {
			throw new Error(`Thread ${threadId} not found`)
		}
		if (thread.status === 'archived') {
			throw new ThreadClosedError({ threadId, op: 'require-open' })
		}
		return thread
	}

	/**
	 * Flip a Thread to `'archived'` via CAS on {@link Thread.ownerVersion}.
	 *
	 * Preconditions (checked in order):
	 *   1. Thread exists for the tenant (throws on absence).
	 *   2. No attached Session is in a non-terminal state (see
	 *      {@link ARCHIVAL_BLOCKING_STATUSES}). The presence check runs
	 *      **before** the idempotent-archive short-circuit so that an already
	 *      archived thread harboring a live session still surfaces as
	 *      {@link ThreadNotEmptyError} rather than a silent success.
	 *   3. If the thread is already `'archived'` the method short-circuits
	 *      without an `updateThread` write (idempotent re-archival). The
	 *      returned record reflects the current persisted state.
	 *
	 * On a fresh archive transition the underlying
	 * {@link ThreadStore.updateThread} call commits with `ownerVersion + 1`.
	 * A {@link import('../../session/errors.js').StaleThreadError} from a
	 * concurrent writer propagates unchanged — the caller is expected to
	 * re-read + retry (mirrors the `updateThread` contract).
	 *
	 * Gate scope (Phase 2.6): `ThreadManager.requireOpen` is wired into
	 * `AgentManager.provisionSpawn` and both handoff flows, so the production
	 * ingress paths cannot attach new sessions under an archived thread.
	 * `SessionStore.createSession` / `updateSession` remain public and
	 * ungated at the store layer — a direct caller can still mutate a
	 * session after archival (the store has no `ThreadStore` handle by
	 * design; cross-store awareness lives in the manager). The defensive
	 * re-check above catches a smuggled live session on a subsequent
	 * archive call, but does not prevent the direct-store write from
	 * landing. That's an acceptable boundary — kernel callers must go
	 * through the ingress paths; direct store consumers are out of scope
	 * for the archive invariant.
	 */
	async archive(threadId: ThreadId, tenantId: TenantId): Promise<Thread> {
		const thread = await this.deps.threadStore.getThread(threadId, tenantId)
		if (!thread) {
			throw new Error(`Thread ${threadId} not found`)
		}

		// Always enforce the blocking-session invariant — even on re-archival.
		// If the thread is already archived but somehow gained a live session
		// (direct store mutation, concurrent spawn before a write-barrier
		// existed), surfacing that via ThreadNotEmptyError is more useful to
		// operators than a silent idempotent success.
		const sessions = await this.deps.sessionStore.listSessions(threadId, tenantId)
		const blocking = sessions.filter((s) => ARCHIVAL_BLOCKING_STATUSES.has(s.status))
		if (blocking.length > 0) {
			throw new ThreadNotEmptyError({
				threadId,
				tenantId,
				op: 'archive',
				blockingSessions: summarizeBlocking(blocking),
				totalBlockingSessions: blocking.length,
			})
		}

		if (thread.status === 'archived') {
			// Idempotent: already archived, no live sessions attached. Skip the
			// write (updateThread would still bump ownerVersion for no semantic
			// change).
			return thread
		}

		const next: Thread = { ...thread, status: 'archived' }
		await this.deps.threadStore.updateThread(next, tenantId)
		// updateThread advances ownerVersion + updatedAt; re-read so the returned
		// record reflects the persisted state (callers rely on version monotonicity).
		const reloaded = await this.deps.threadStore.getThread(threadId, tenantId)
		if (!reloaded) {
			throw new Error(`Thread ${threadId} vanished between archive and read-back`)
		}
		return reloaded
	}

	/**
	 * Hard-delete a Thread record. Rejects with {@link ThreadNotEmptyError}
	 * (`op: 'delete'`) when ANY Session still references the Thread —
	 * deletion is stricter than archival, which tolerates quiescent sessions.
	 * Callers must first delete or archive-and-tombstone every attached
	 * session (via {@link SessionStore.deleteSession}) before invoking.
	 *
	 * The session scan runs unconditionally, so orphaned sessions pointing at
	 * a missing thread are still detected and reject the delete. Idempotent
	 * for genuinely absent threads (no sessions, no thread record) — missing
	 * thread + empty session list is a no-op at the store layer. Convention
	 * #5: deny-by-default; no implicit cascade into SessionStore.
	 */
	async delete(threadId: ThreadId, tenantId: TenantId): Promise<void> {
		const sessions = await this.deps.sessionStore.listSessions(threadId, tenantId)
		if (sessions.length > 0) {
			throw new ThreadNotEmptyError({
				threadId,
				tenantId,
				op: 'delete',
				blockingSessions: summarizeBlocking(sessions),
				totalBlockingSessions: sessions.length,
			})
		}
		await this.deps.threadStore.deleteThread(threadId, tenantId)
	}
}

function summarizeBlocking(
	sessions: readonly Session[],
): ReadonlyArray<{ sessionId: Session['id']; status: SessionStatus }> {
	return sessions
		.slice(0, THREAD_NOT_EMPTY_SAMPLE_LIMIT)
		.map((s) => ({ sessionId: s.id, status: s.status }))
}
