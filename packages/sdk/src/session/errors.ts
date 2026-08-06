/**
 * Typed errors for the session hierarchy module.
 *
 * See session-hierarchy.md §12.2 (cross-tenant rejection), §6.2 (workspace
 * backend operation failures), §4.5 (intervention DAG). Each error carries a
 * structured `details` payload so consumers can route without string parsing
 * (Convention #5: deny-by-default, fail fast).
 */

import type { SessionId, TenantId } from '../types/ids/index.js'
import type { SessionStatus } from '../types/session/entity.js'
import type { ProjectId, ThreadId } from '../types/session/ids.js'
import type { WorkspaceBackendKind } from './workspace/driver.js'

/**
 * Raised by {@link SessionStore} accessors when the supplied {@link TenantId}
 * does not match the tenant owning the target resource. Convention #17:
 * cross-tenant access is a hard error at the kernel boundary — there is no
 * escape hatch. See session-hierarchy.md §12.2.
 */
export class TenantIsolationError extends Error {
	readonly details: {
		requested: TenantId
		resource: string
	}

	constructor(details: { requested: TenantId; resource: string }) {
		super(`Tenant isolation violation: ${details.requested} accessed ${details.resource}`)
		this.name = 'TenantIsolationError'
		this.details = details
	}
}

/**
 * Raised by {@link SessionStore.getAncestry} / {@link SessionStore.drill}
 * when walking parent sub-session links encounters a revisit. Indicates store
 * corruption — the write path enforces acyclicity (session-hierarchy.md §4.5).
 */
export class AncestryCycleError extends Error {
	readonly details: {
		sessionId: SessionId
		cyclePath: readonly SessionId[]
	}

	constructor(details: { sessionId: SessionId; cyclePath: readonly SessionId[] }) {
		super(
			`Ancestry cycle detected starting at ${details.sessionId}: ${details.cyclePath.join(' -> ')}`,
		)
		this.name = 'AncestryCycleError'
		this.details = details
	}
}

/**
 * Raised by {@link WorkspaceBackendDriver} implementations on any I/O or
 * invariant failure. Wraps the underlying cause; callers can match on
 * `details.op` + `details.kind` for routing (Convention #0: no silent
 * fallbacks — surface the failure). See session-hierarchy.md §6.2 / §7.
 */
export class WorkspaceBackendError extends Error {
	readonly details: {
		op: string
		kind: WorkspaceBackendKind
		cause?: unknown
	}

	constructor(details: { op: string; kind: WorkspaceBackendKind; cause?: unknown }) {
		super(`Workspace backend ${details.kind} failed on ${details.op}`)
		this.name = 'WorkspaceBackendError'
		this.details = details
	}
}

/**
 * Raised by {@link import('../types/thread/store.js').ThreadStore.updateThread}
 * when the supplied {@link Thread.ownerVersion} does not match the persisted
 * record. The caller must re-read via `getThread`, re-apply its intended
 * mutation on top of the fresh record, and retry. Mirrors the Session
 * handoff CAS pattern (§6.1).
 */
export class StaleThreadError extends Error {
	readonly details: {
		threadId: ThreadId
		expectedVersion: number
		actualVersion: number
	}

	constructor(details: { threadId: ThreadId; expectedVersion: number; actualVersion: number }) {
		super(
			`Stale Thread ${details.threadId}: expected ownerVersion=${details.expectedVersion}, actual=${details.actualVersion}`,
		)
		this.name = 'StaleThreadError'
		this.details = details
	}
}

/**
 * Raised when a Session write names a version the store no longer has.
 *
 * The sibling of {@link StaleThreadError}, and it arrived much later: Thread
 * had a working compare-and-set from the start while `Session.ownerVersion`
 * was documented as a CAS counter that nothing enforced. Two concurrent
 * handoffs could both pass, both provision a worktree, and one silently erase
 * the other.
 *
 * `actualVersion` is what the store holds, not what the caller sent — the
 * caller already knows what it sent, and the useful half of the answer is how
 * far behind it is.
 */
export class StaleSessionError extends Error {
	readonly details: {
		sessionId: SessionId
		expectedVersion: number
		actualVersion: number
	}

	constructor(details: { sessionId: SessionId; expectedVersion: number; actualVersion: number }) {
		super(
			`Stale Session ${details.sessionId}: expected ownerVersion=${details.expectedVersion}, actual=${details.actualVersion}. Another writer took ownership; re-read the session before retrying.`,
		)
		this.name = 'StaleSessionError'
		this.details = details
	}
}

/**
 * Raised by the spawn path (and any caller that enforces the open-thread
 * precondition) when a Thread is in `'archived'` state and would-be mutations
 * require it to be `'open'`. Convention #5: deny-by-default — archival is a
 * hard read-only boundary.
 */
export class ThreadClosedError extends Error {
	readonly details: {
		threadId: ThreadId
		op: string
	}

	constructor(details: { threadId: ThreadId; op: string }) {
		super(`Thread ${details.threadId} is archived; operation '${details.op}' rejected`)
		this.name = 'ThreadClosedError'
		this.details = details
	}
}

/**
 * Raised by {@link import('../manager/thread/lifecycle.js').ThreadManager.archive}
 * and `.delete` when the Thread's session-presence precondition is violated:
 *
 * - `op: 'archive'` — at least one Session under the Thread is in a
 *   non-terminal state (`active | locked | awaiting_hitl | awaiting_merge`).
 *   The caller must first quiesce those sessions (let them reach `idle`,
 *   `failed`, or `archived`) before flipping the Thread to archived.
 * - `op: 'delete'` — the Thread still has at least one attached Session.
 *   Callers must either archive + tombstone those sessions (`deleteSession`)
 *   before calling `deleteThread`, or accept that deletion is not yet safe.
 *
 * `blockingSessions` carries the first {@link THREAD_NOT_EMPTY_SAMPLE_LIMIT}
 * offenders with their current status so operator tooling can surface an
 * actionable list without unbounded error payloads on large threads.
 * `totalBlockingSessions` holds the full count even when the sample is
 * truncated. Convention #5: deny-by-default — no implicit cascade, no silent
 * no-op.
 */
export const THREAD_NOT_EMPTY_SAMPLE_LIMIT = 50

export class ThreadNotEmptyError extends Error {
	readonly details: {
		threadId: ThreadId
		tenantId: TenantId
		op: 'archive' | 'delete'
		blockingSessions: ReadonlyArray<{ sessionId: SessionId; status: SessionStatus }>
		totalBlockingSessions: number
	}

	constructor(details: {
		threadId: ThreadId
		tenantId: TenantId
		op: 'archive' | 'delete'
		blockingSessions: ReadonlyArray<{ sessionId: SessionId; status: SessionStatus }>
		totalBlockingSessions: number
	}) {
		super(
			`Thread ${details.threadId} ${details.op} blocked: ${details.totalBlockingSessions} session(s) still attached`,
		)
		this.name = 'ThreadNotEmptyError'
		this.details = details
	}
}

/**
 * Raised when an ingress path is asked to attach work to an archived Project.
 *
 * The sibling of {@link ThreadClosedError}, on the level that survives. A
 * closed workspace is a decision by its owner, and the paths that create
 * sessions have to be able to see it — otherwise "archived" is a word in a
 * listing rather than a state of the system.
 */
export class ProjectClosedError extends Error {
	readonly details: {
		projectId: ProjectId
		op: string
	}

	constructor(details: { projectId: ProjectId; op: string }) {
		super(`Project ${details.projectId} is archived; operation '${details.op}' rejected`)
		this.name = 'ProjectClosedError'
		this.details = details
	}
}

/**
 * Raised by the project archive path when sessions are still attached and not
 * in a terminal state.
 *
 * Archiving does not cascade and does not kill anything: a live session is a
 * running agent, and closing its workspace out from under it would strand
 * work whose owner is still watching. The caller settles the sessions first.
 * `blockingSessions` is truncated to {@link PROJECT_NOT_EMPTY_SAMPLE_LIMIT};
 * `totalBlockingSessions` is the real count.
 */
export const PROJECT_NOT_EMPTY_SAMPLE_LIMIT = 50

export class ProjectNotEmptyError extends Error {
	readonly details: {
		projectId: ProjectId
		tenantId: TenantId
		op: 'archive'
		blockingSessions: ReadonlyArray<{ sessionId: SessionId; status: SessionStatus }>
		totalBlockingSessions: number
	}

	constructor(details: {
		projectId: ProjectId
		tenantId: TenantId
		op: 'archive'
		blockingSessions: ReadonlyArray<{ sessionId: SessionId; status: SessionStatus }>
		totalBlockingSessions: number
	}) {
		super(
			`Project ${details.projectId} ${details.op} blocked: ${details.totalBlockingSessions} session(s) still attached`,
		)
		this.name = 'ProjectNotEmptyError'
		this.details = details
	}
}

/**
 * Raised when a project status write loses a compare-and-set.
 *
 * The sibling of {@link StaleSessionError}: the caller re-reads and decides
 * again, because the project it was about to close is not the project on
 * disk.
 */
export class StaleProjectError extends Error {
	readonly details: {
		projectId: ProjectId
		expectedOwnerVersion: number
		actualOwnerVersion: number
	}

	constructor(details: {
		projectId: ProjectId
		expectedOwnerVersion: number
		actualOwnerVersion: number
	}) {
		super(
			`Project ${details.projectId} was modified concurrently: expected ownerVersion ${details.expectedOwnerVersion}, found ${details.actualOwnerVersion}`,
		)
		this.name = 'StaleProjectError'
		this.details = details
	}
}
