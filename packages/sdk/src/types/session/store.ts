/**
 * SessionStore — canonical persistence contract for the session hierarchy.
 *
 * Every accessor takes explicit {@link TenantId} (Convention #17). Cross-tenant
 * access rejects with `TenantIsolationError`. Convention #0: no speculative
 * API — extensions land alongside their consumers.
 */

import type { Project, ProjectStatus } from '../../types/project/entity.js'
import type { ActorRef } from '../../types/session/actor.js'
import type { Session } from '../../types/session/entity.js'
import type { SessionMessage } from '../../types/session/messages.js'
import type {
	CompletionMode,
	FailureMode,
	SubSession,
	SubSessionKind,
} from '../../types/session/sub-session.js'
import type { SessionSummaryRef } from '../../types/summary/ref.js'
import type { MessageId, SessionId, TenantId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ProjectId, SubSessionId, SummaryId, ThreadId } from '../session/ids.js'

/**
 * Params for {@link SessionStore.createSession}. The store owns id generation,
 * `ownerVersion` initialization, and timestamps.
 *
 * Both `threadId` and `projectId` are required. `projectId` must equal the
 * `projectId` of the thread identified by `threadId`; the store does NOT
 * perform that cross-store consistency check (it has no ThreadStore handle
 * by design — see the store-boundary rationale in {@link ThreadStore}). The
 * caller is the authority; typically spawn and handoff paths copy both from
 * a freshly-loaded `Thread` record or from their own context which already
 * tracks both.
 */
export interface CreateSessionParams {
	threadId: ThreadId
	projectId: ProjectId
	/**
	 * Initial owner of the session. May be `null` for bootstrap scenarios where
	 * the first Run attaches an actor; the store rejects mutations against
	 * actor-less sessions from downstream consumers.
	 */
	currentActor: ActorRef | null
}

/**
 * Params for {@link SessionStore.createSubSession}. `workspaceId` is optional
 * because Phase 3 does not yet wire workspace creation into spawn — Phase 6
 * makes the two atomic. `summaryRef` is populated by the materializer in
 * Phase 5, never by callers of this API.
 */
export interface CreateSubSessionParams {
	parentSessionId: SessionId
	childSessionId: SessionId
	kind: SubSessionKind
	spawnedBy: ActorRef
	failureMode?: FailureMode
	completionMode?: CompletionMode
}

/**
 * Minimal Project surface needed by the store in Phase 3. The full Project
 * entity lives in `session/hierarchy/project.ts`; a dedicated `ProjectStore`
 * is out of scope for this phase (session-hierarchy.md §11 defers the project
 * store to a later phase).
 */
/**
 * The part of a Project's configuration a caller may actually set.
 *
 * **Exactly the fields something reads.** `ProjectConfig` declares eight; five
 * enforcement sites read two of them, and the other six have zero readers in
 * production — `maxInterventionDepth` included, whose three apparent hits are
 * all comments claiming a wiring that does not exist. Exposing those here
 * would make a dead field *easier to set*, which is worse than leaving it
 * unreachable: a host would configure a retention policy, get no error, and
 * believe retention was on.
 *
 * The rule is the repo's own: name the code that reads a declaration before
 * shipping it. When a field gains a reader it gains a line here in the same
 * change, and not before.
 */
export interface ProjectConfigInput {
	/** Read by the spawn path and both handoff paths. Default 4. */
	maxDelegationDepth?: number
	/** Read by the spawn path and broadcast handoff. Default 8. */
	maxDelegationWidth?: number
}

export interface CreateProjectParams {
	tenantId: TenantId
	name: string

	/**
	 * Per-workspace limits. Omitted fields keep the defaults.
	 *
	 * Until this existed every project in existence ran at depth 4 / width 8,
	 * because the config was hardcoded identically in both stores and there was
	 * no way to write one afterwards. A tenant with several workspaces could
	 * not give them different limits, which is most of what having several
	 * workspaces is for.
	 */
	config?: ProjectConfigInput
}

/**
 * Return shape for {@link SessionStore.drill}. See session-hierarchy.md §14.3.
 * The fields are final — consumers may rely on exhaustiveness (Convention #6).
 *
 * `ancestry` is root-to-self. `children` lists direct sub-sessions only
 * (recursive drill-down is the consumer's responsibility).
 */
export interface SessionView {
	session: Session
	children: readonly SubSession[]
	ancestry: readonly SessionId[]
}

/**
 * Canonical persistence contract. Every accessor takes explicit `tenantId`.
 * Cross-tenant reads/writes must reject with `TenantIsolationError`
 * (see `session/errors.ts`).
 *
 * Read accessors return `null` when the resource does not exist for the
 * supplied tenant — this is the deny-by-default surface (Convention #5):
 * callers never get a fallback and must branch on missing explicitly.
 */
export interface SessionStore {
	// Project CRUD ------------------------------------------------------------

	createProject(params: CreateProjectParams, tenantId: TenantId): Promise<Project>

	getProject(projectId: ProjectId, tenantId: TenantId): Promise<Project | null>

	/**
	 * Change a Project's limits after it exists. OPTIONAL.
	 *
	 * Optional because widening a store interface is invisible to callers and
	 * fatal to implementors: a host with its own `SessionStore` should not stop
	 * compiling because the SDK grew a method. Callers check for it; the two
	 * stores here implement it.
	 *
	 * Only the fields in {@link ProjectConfigInput} can move, and an omitted
	 * field is left alone rather than reset — a caller raising the width is not
	 * saying anything about the depth. Returns the updated Project, or `null`
	 * if it does not exist.
	 */
	updateProject?(
		projectId: ProjectId,
		config: ProjectConfigInput,
		tenantId: TenantId,
	): Promise<Project | null>

	/**
	 * Every Project this tenant owns, oldest first. OPTIONAL, same reasoning.
	 *
	 * The tenant is the isolation boundary, so this is scoped to it and to
	 * nothing else — there is no level above Project to filter by.
	 */
	listProjects?(tenantId: TenantId): Promise<readonly Project[]>

	/**
	 * Open or close a workspace. OPTIONAL, same reasoning as the two above.
	 *
	 * Compare-and-set on {@link Project.ownerVersion}: pass the version you
	 * read, and a concurrent writer makes this throw `StaleProjectError`
	 * instead of silently winning. On success the stored version is bumped.
	 *
	 * Both directions, because a workspace is long-lived and closing one by
	 * mistake should not be permanent — unlike the Thread status this replaces,
	 * which only ever went one way. Returns `null` if the project does not
	 * exist; writing to another tenant's project throws.
	 *
	 * This is the store-level write. The precondition that no live session is
	 * attached belongs to {@link import('../../manager/project/lifecycle.js').ProjectManager},
	 * because the store deliberately holds no view of what is running.
	 */
	setProjectStatus?(
		projectId: ProjectId,
		status: ProjectStatus,
		tenantId: TenantId,
		expectedOwnerVersion: number,
	): Promise<Project | null>

	// Session CRUD ------------------------------------------------------------

	createSession(params: CreateSessionParams, tenantId: TenantId): Promise<Session>

	getSession(sessionId: SessionId, tenantId: TenantId): Promise<Session | null>

	/**
	 * Write a Session back, optionally only if nobody else wrote it first.
	 *
	 * **`expectedOwnerVersion` is the single-writer lock this level is supposed
	 * to own, and it did not exist.** `Session.ownerVersion` is documented as
	 * the CAS counter for handoff, but nothing enforced it: both stores
	 * overwrote unconditionally, and the handoff's own check compared a
	 * snapshot it had read several awaits earlier against itself. Two
	 * concurrent handoffs on one idle session both passed, both provisioned a
	 * worktree, and one silently erased the other.
	 *
	 * Supply it and the store compares against the version it HAS STORED —
	 * not against the payload, which is the caller's stale copy — and throws
	 * {@link StaleSessionError} rather than writing. Omit it and the behaviour
	 * is exactly what it always was, which is the compatibility promise: this
	 * parameter is optional so that widening the interface stays invisible to
	 * callers and harmless to hosts implementing their own store. A required
	 * parameter would break every implementor for a guarantee they can opt
	 * into.
	 *
	 * **In-process only, stated rather than implied.** `DiskSessionStore`
	 * writes atomically, but its read-compare-write is not a critical section,
	 * so two PROCESSES can still both pass the check. Closing that needs a
	 * lease with an expiry — not a PID registry, because a Session is durable
	 * and written from hosts where a PID is not a checkable fact. The same
	 * honesty the spawn lock already carries.
	 */
	updateSession(session: Session, tenantId: TenantId, expectedOwnerVersion?: number): Promise<void>

	/**
	 * List every Session that belongs to the given Thread for the caller's
	 * tenant, ordered by `createdAt` ascending. Returns an empty array when
	 * none exist.
	 *
	 * Thread-scoped queries rely on `session.threadId` (set at creation, never
	 * rewritten). Cross-tenant sessions that happen to share the supplied
	 * `threadId` are silently skipped — the listing is tenant-scoped, not an
	 * isolation violation (the caller did not request a specific record).
	 *
	 * Exists to back ThreadManager's archival + delete preconditions
	 * ({@link import('../../manager/thread/lifecycle.js').ThreadManager.archive}
	 * rejects when any session is in a non-terminal state; `delete` rejects
	 * while any session still references the thread). Keeping this primitive
	 * on {@link SessionStore} preserves the store-ownership boundary —
	 * ThreadStore stays unaware of session layout (Convention #0).
	 */
	listSessions(threadId: ThreadId, tenantId: TenantId): Promise<readonly Session[]>

	/**
	 * Every Session attached to a workspace, oldest first. OPTIONAL.
	 *
	 * The project-scoped sibling of {@link SessionStore.listSessions}, and the
	 * one the archive precondition reads: closing a workspace has to know what
	 * is still running in it, and "what is running in this thread" was never
	 * the question — a project can hold sessions across many threads, and after
	 * the Thread level is removed it is the only grouping left.
	 */
	listSessionsByProject?(projectId: ProjectId, tenantId: TenantId): Promise<readonly Session[]>

	/**
	 * Hard-delete a session. Idempotent — absent sessions succeed as a no-op.
	 * Rejects with `TenantIsolationError` on cross-tenant access.
	 *
	 * Closes the Phase 4 Known Delta (broadcast rollback previously had to
	 * flip status to `'archived'` as a stopgap). Used by:
	 *   - Broadcast rollback (compensating cleanup — pattern doc §6.2)
	 *   - Archival tombstone consolidation when a caller prefers deletion
	 *     over the in-slot tombstone (uncommon — default is in-slot).
	 *
	 * Policy: rejects when the session still has sub-sessions attached —
	 * callers must delete children first. This keeps the operation a single,
	 * locally-reasoning write rather than an implicit recursive cascade
	 * (Convention #5 deny-by-default).
	 */
	deleteSession(sessionId: SessionId, tenantId: TenantId): Promise<void>

	// SubSession CRUD ---------------------------------------------------------

	createSubSession(params: CreateSubSessionParams, tenantId: TenantId): Promise<SubSession>

	getSubSession(subSessionId: SubSessionId, tenantId: TenantId): Promise<SubSession | null>

	updateSubSession(subSession: SubSession, tenantId: TenantId): Promise<void>

	/**
	 * Hard-delete a sub-session record. Idempotent — absent sub-sessions
	 * succeed as a no-op. Rejects with `TenantIsolationError` on cross-tenant
	 * access. Does not cascade to the owned child session; the caller owns
	 * that (typical broadcast-rollback flow deletes the sub-session first,
	 * then the child session).
	 */
	deleteSubSession(subSessionId: SubSessionId, tenantId: TenantId): Promise<void>

	// Messages -----------------------------------------------------------------

	/**
	 * Append a single message to the session's message log. Returns the
	 * assigned {@link MessageId}. Write is append-only; the store never
	 * rewrites or reorders previously persisted messages.
	 */
	appendMessage(sessionId: SessionId, message: Message, tenantId: TenantId): Promise<MessageId>

	/**
	 * Load the full message history for a session in insertion order.
	 * Returns an empty array when the session has no messages.
	 *
	 * Returns payload-only {@link Message} records. Callers that need the
	 * full persistence envelope (including {@link MessageId} and timestamp)
	 * should use {@link SessionStore.loadSessionMessages} instead.
	 */
	loadMessages(sessionId: SessionId, tenantId: TenantId): Promise<readonly Message[]>

	/**
	 * Load the full {@link SessionMessage} envelope for every persisted
	 * message in insertion order (Phase 9 Known Delta #7). Unlike
	 * {@link SessionStore.loadMessages} this preserves the original
	 * {@link MessageId} and timestamp — required for full-fidelity archival
	 * round-trips via {@link ArchivalManager.archive}.
	 *
	 * Returns an empty array when the session has no messages; cross-tenant
	 * reads reject with `TenantIsolationError` (Convention #17).
	 */
	loadSessionMessages(sessionId: SessionId, tenantId: TenantId): Promise<readonly SessionMessage[]>

	// Linkage (pattern doc §10.4 / §14.3) ------------------------------------

	/**
	 * Direct children of the session (one level). Returns an empty array when
	 * the session has no delegations.
	 */
	getChildren(sessionId: SessionId, tenantId: TenantId): Promise<readonly SubSession[]>

	/**
	 * Session id chain from root to self, inclusive. Walks parent sub-session
	 * links. Rejects on cycle via `session/errors.ts#AncestryCycleError` —
	 * the write path enforces acyclicity, so a cycle here indicates store
	 * corruption.
	 */
	getAncestry(sessionId: SessionId, tenantId: TenantId): Promise<readonly SessionId[]>

	/**
	 * Single-round navigation primitive. Returns `null` when the session does
	 * not exist for the tenant. See session-hierarchy.md §14.3.
	 */
	drill(sessionId: SessionId, tenantId: TenantId): Promise<SessionView | null>

	// Summary (pattern doc §4.7 / §8.1) --------------------------------------

	/**
	 * @internal Kernel-internal. Call through
	 * `SessionSummaryMaterializer.materialize`, never directly. The
	 * `materializedBy: 'kernel'` constraint on the argument type ensures
	 * external callers cannot construct a valid input — the only mint site for
	 * `SummaryId` is `generateSummaryId` inside the Materializer.
	 *
	 * Atomic write-then-status-flip (Convention #8): persists the summary and
	 * transitions the owning Session's status to `'idle'` if it was in a
	 * non-terminal state (`'active' | 'locked' | 'awaiting_merge'`). The two
	 * writes commit as one logical unit; mid-crash recovery is replay via
	 * `SessionSummaryMaterializer.recover()`.
	 *
	 * Rejects with {@link SessionAlreadySummarizedError} if a summary already
	 * exists for the session (re-materialization forbidden; see
	 * session-hierarchy.md §4.7 immutability invariant).
	 */
	recordSummary(
		summary: SessionSummaryRef & { materializedBy: 'kernel' },
		tenantId: TenantId,
	): Promise<void>

	/**
	 * Loads the persisted summary for a session. Returns `null` when none has
	 * been materialized. Cross-tenant reads reject with `TenantIsolationError`
	 * (Convention #17).
	 */
	getSummary(sessionId: SessionId, tenantId: TenantId): Promise<SessionSummaryRef | null>
}

/**
 * Re-export of {@link SummaryId} so downstream consumers importing from
 * `types/session/store.js` pick up the brand alongside the store contract.
 */
export type { SummaryId }
