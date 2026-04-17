/**
 * SessionStore — canonical persistence contract for the session hierarchy.
 *
 * Replaces `ConversationStore` (deprecated; `types/conversation/index.ts`).
 * Per session-hierarchy.md §4 Entity Model, §10.4 Parent-Child Linkage, §12
 * Multi-Tenant and Security — every accessor takes explicit {@link TenantId}
 * (Convention #17). Cross-tenant access rejects with `TenantIsolationError`.
 *
 * Minimum surface — covers downstream phases 4 (handoff), 5 (summary), and
 * 6 (sub-session spawn) plus the drill primitive (§14.3). Extensions land in
 * paired phases alongside their consumers (Convention #0: no speculative API).
 */

import type { ActorRef } from '../../session/hierarchy/actor.js'
import type { Project } from '../../session/hierarchy/project.js'
import type { Session } from '../../session/hierarchy/session.js'
import type {
	CompletionMode,
	FailureMode,
	SubSession,
	SubSessionKind,
} from '../../session/hierarchy/sub-session.js'
import type { MessageId, SessionId, TenantId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ProjectId, SubSessionId } from '../session/ids.js'

/**
 * Params for {@link SessionStore.createSession}. The store owns id generation,
 * `ownerVersion` initialization, and timestamps. See session-hierarchy.md §4.3.
 */
export interface CreateSessionParams {
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
export interface CreateProjectParams {
	tenantId: TenantId
	name: string
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

	// Session CRUD ------------------------------------------------------------

	createSession(params: CreateSessionParams, tenantId: TenantId): Promise<Session>

	getSession(sessionId: SessionId, tenantId: TenantId): Promise<Session | null>

	updateSession(session: Session, tenantId: TenantId): Promise<void>

	// SubSession CRUD ---------------------------------------------------------

	createSubSession(params: CreateSubSessionParams, tenantId: TenantId): Promise<SubSession>

	getSubSession(subSessionId: SubSessionId, tenantId: TenantId): Promise<SubSession | null>

	updateSubSession(subSession: SubSession, tenantId: TenantId): Promise<void>

	// Messages (replaces ConversationStore surface) ---------------------------

	/**
	 * Append a single message to the session's message log. Returns the
	 * assigned {@link MessageId}. Write is append-only; the store never
	 * rewrites or reorders previously persisted messages.
	 */
	appendMessage(sessionId: SessionId, message: Message, tenantId: TenantId): Promise<MessageId>

	/**
	 * Load the full message history for a session in insertion order.
	 * Returns an empty array when the session has no messages.
	 */
	loadMessages(sessionId: SessionId, tenantId: TenantId): Promise<readonly Message[]>

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
}
