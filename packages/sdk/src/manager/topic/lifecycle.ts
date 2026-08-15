/**
 * TopicManager — thin orchestrator over {@link TopicStore} and
 * {@link SessionStore}.
 *
 * Owns user-facing lifecycle operations on the Topic layer plus the
 * archive-gate contract enforced at session-creation ingress sites.
 *
 * Phase 2.6 wired `TopicManager.requireOpen` into three ingress paths:
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
 *
 * NZ-TOPIC-01 renamed this class from `ThreadManager` (moved from
 * `manager/thread/lifecycle.ts`). `ThreadManager` keeps working, unaliased —
 * `public-runtime.ts` re-exports it as a literal identity binding to this
 * class, not a wrapper, so `instanceof` and `===` both still hold for a
 * caller who has not migrated. NZ-TOPIC-03 renamed the `threadId`
 * parameter on every method below to `topicId` — the FK-field rename that
 * release deliberately deferred, now landed with its own data migration in
 * `store/session/disk.ts`. `threadStore` (a DI dependency, not the FK)
 * stayed `topicStore` from that same release. The thrown error classes
 * (`ThreadClosedError`/`ThreadNotEmptyError`) are STILL unchanged, and so
 * is their `details.threadId` field — `session/errors.ts` is still not in
 * this task's file list; renaming them with a proper deprecated alias
 * remains a clean follow-up. Constructing one from a `topicId` local below
 * therefore spells the key out (`{ threadId: topicId, ... }`) rather than
 * using shorthand.
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
import type { Topic } from '../../types/topic/entity.js'
import type { CreateTopicParams, TopicStore } from '../../types/topic/store.js'

export interface TopicManagerDeps {
	readonly topicStore: TopicStore
	readonly sessionStore: SessionStore
}

/**
 * Session statuses that block Topic archival. A session in any of these
 * states has live work in-flight (mid-run, mid-handoff, blocked on human
 * input, or orchestrating a broadcast merge) — freezing the Topic while any
 * of them are active would strand resumable work.
 *
 * `idle`, `failed`, and `archived` are archival-compatible: they are
 * quiescent or already-terminal, so a newly-frozen Topic can safely contain
 * them. This list mirrors the `SessionStatus` discriminants that represent
 * "not-yet-done" work (session-hierarchy.md §5.1).
 */
const ARCHIVAL_BLOCKING_STATUSES: ReadonlySet<SessionStatus> = new Set([
	'active',
	'locked',
	'awaiting_hitl',
	'awaiting_merge',
])

export class TopicManager {
	private readonly deps: TopicManagerDeps

	constructor(deps: TopicManagerDeps) {
		this.deps = deps
	}

	/** Persist a new Topic. Thin passthrough for uniformity at the manager surface. */
	create(params: CreateTopicParams, tenantId: TenantId): Promise<Topic> {
		return this.deps.topicStore.createTopic(params, tenantId)
	}

	/** Read a Topic by id; returns `null` when absent for the tenant. */
	get(topicId: ThreadId, tenantId: TenantId): Promise<Topic | null> {
		return this.deps.topicStore.getTopic(topicId, tenantId)
	}

	/**
	 * CAS update on a Topic. Propagates {@link import('../../session/errors.js').StaleThreadError}
	 * from the store on `ownerVersion` mismatch — callers re-read, re-apply,
	 * and retry.
	 */
	update(topic: Topic, tenantId: TenantId): Promise<void> {
		return this.deps.topicStore.updateTopic(topic, tenantId)
	}

	/** List Topics under a Project, ordered by `createdAt` ascending. */
	list(projectId: ProjectId, tenantId: TenantId): Promise<readonly Topic[]> {
		return this.deps.topicStore.listTopics(projectId, tenantId)
	}

	/**
	 * Load a Topic and assert it is in `'open'` state. Used by the spawn path
	 * as a precondition — a SubSession cannot be created under an archived
	 * Topic. Throws on absence and on archival; returns the loaded Topic on
	 * success so callers can avoid the second round-trip.
	 *
	 * Convention #5: deny-by-default. A missing Topic is a hard error, not a
	 * silent "assume archived".
	 */
	async requireOpen(topicId: ThreadId, tenantId: TenantId): Promise<Topic> {
		const topic = await this.deps.topicStore.getTopic(topicId, tenantId)
		if (!topic) {
			throw new Error(`Topic ${topicId} not found`)
		}
		if (topic.status === 'archived') {
			throw new ThreadClosedError({ threadId: topicId, op: 'require-open' })
		}
		return topic
	}

	/**
	 * Flip a Topic to `'archived'` via CAS on {@link Topic.ownerVersion}.
	 *
	 * Preconditions (checked in order):
	 *   1. Topic exists for the tenant (throws on absence).
	 *   2. No attached Session is in a non-terminal state (see
	 *      {@link ARCHIVAL_BLOCKING_STATUSES}). The presence check runs
	 *      **before** the idempotent-archive short-circuit so that an already
	 *      archived topic harboring a live session still surfaces as
	 *      {@link ThreadNotEmptyError} rather than a silent success.
	 *   3. If the topic is already `'archived'` the method short-circuits
	 *      without an `updateTopic` write (idempotent re-archival). The
	 *      returned record reflects the current persisted state.
	 *
	 * On a fresh archive transition the underlying
	 * {@link TopicStore.updateTopic} call commits with `ownerVersion + 1`.
	 * A {@link import('../../session/errors.js').StaleThreadError} from a
	 * concurrent writer propagates unchanged — the caller is expected to
	 * re-read + retry (mirrors the `updateTopic` contract).
	 *
	 * Gate scope (Phase 2.6): `TopicManager.requireOpen` is wired into
	 * `AgentManager.provisionSpawn` and both handoff flows, so the production
	 * ingress paths cannot attach new sessions under an archived topic.
	 * `SessionStore.createSession` / `updateSession` remain public and
	 * ungated at the store layer — a direct caller can still mutate a
	 * session after archival (the store has no `TopicStore` handle by
	 * design; cross-store awareness lives in the manager). The defensive
	 * re-check above catches a smuggled live session on a subsequent
	 * archive call, but does not prevent the direct-store write from
	 * landing. That's an acceptable boundary — kernel callers must go
	 * through the ingress paths; direct store consumers are out of scope
	 * for the archive invariant.
	 */
	async archive(topicId: ThreadId, tenantId: TenantId): Promise<Topic> {
		const topic = await this.deps.topicStore.getTopic(topicId, tenantId)
		if (!topic) {
			throw new Error(`Topic ${topicId} not found`)
		}

		// Always enforce the blocking-session invariant — even on re-archival.
		// If the topic is already archived but somehow gained a live session
		// (direct store mutation, concurrent spawn before a write-barrier
		// existed), surfacing that via ThreadNotEmptyError is more useful to
		// operators than a silent idempotent success.
		const sessions = await this.deps.sessionStore.listSessionsByTopic(topicId, tenantId)
		const blocking = sessions.filter((s) => ARCHIVAL_BLOCKING_STATUSES.has(s.status))
		if (blocking.length > 0) {
			throw new ThreadNotEmptyError({
				threadId: topicId,
				tenantId,
				op: 'archive',
				blockingSessions: summarizeBlocking(blocking),
				totalBlockingSessions: blocking.length,
			})
		}

		if (topic.status === 'archived') {
			// Idempotent: already archived, no live sessions attached. Skip the
			// write (updateTopic would still bump ownerVersion for no semantic
			// change).
			return topic
		}

		const next: Topic = { ...topic, status: 'archived' }
		await this.deps.topicStore.updateTopic(next, tenantId)
		// updateTopic advances ownerVersion + updatedAt; re-read so the returned
		// record reflects the persisted state (callers rely on version monotonicity).
		const reloaded = await this.deps.topicStore.getTopic(topicId, tenantId)
		if (!reloaded) {
			throw new Error(`Topic ${topicId} vanished between archive and read-back`)
		}
		return reloaded
	}

	/**
	 * Hard-delete a Topic record. Rejects with {@link ThreadNotEmptyError}
	 * (`op: 'delete'`) when ANY Session still references the Topic —
	 * deletion is stricter than archival, which tolerates quiescent sessions.
	 * Callers must first delete or archive-and-tombstone every attached
	 * session (via {@link SessionStore.deleteSession}) before invoking.
	 *
	 * The session scan runs unconditionally, so orphaned sessions pointing at
	 * a missing topic are still detected and reject the delete. Idempotent
	 * for genuinely absent topics (no sessions, no topic record) — missing
	 * topic + empty session list is a no-op at the store layer. Convention
	 * #5: deny-by-default; no implicit cascade into SessionStore.
	 */
	async delete(topicId: ThreadId, tenantId: TenantId): Promise<void> {
		const sessions = await this.deps.sessionStore.listSessionsByTopic(topicId, tenantId)
		if (sessions.length > 0) {
			throw new ThreadNotEmptyError({
				threadId: topicId,
				tenantId,
				op: 'delete',
				blockingSessions: summarizeBlocking(sessions),
				totalBlockingSessions: sessions.length,
			})
		}
		await this.deps.topicStore.deleteTopic(topicId, tenantId)
	}
}

function summarizeBlocking(
	sessions: readonly Session[],
): ReadonlyArray<{ sessionId: Session['id']; status: SessionStatus }> {
	return sessions
		.slice(0, THREAD_NOT_EMPTY_SAMPLE_LIMIT)
		.map((s) => ({ sessionId: s.id, status: s.status }))
}
