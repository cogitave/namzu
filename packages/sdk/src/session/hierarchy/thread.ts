import type { TenantId } from '../../types/ids/index.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'

/**
 * Lifecycle state of a Thread.
 *
 * - `open` — accepts new Sessions and new Runs under existing Sessions.
 * - `archived` — read-only tombstone. No new Sessions may be created; existing
 *   Sessions remain navigable. Transitioning `open → archived` requires that
 *   no Session under the Thread is in a non-terminal state (guarded at the
 *   store level by listing + status fan-in).
 *
 * There is no `active` variant — Thread does NOT derive status from its child
 * Sessions the way a Session does from its Runs. Thread is a pure container
 * (Phase 0 decision B.1: Thread is container-only, no message stream, no
 * fan-in). Its status is an explicit owner action.
 */
export type ThreadStatus = 'open' | 'archived'

/**
 * Topic-level container sitting between {@link ProjectId Project} and
 * {@link import('../../types/session/ids.js').SessionId Session} in the
 * five-layer hierarchy (Project → Thread → Session → SubSession → Run).
 *
 * A Thread groups together many Sessions that address the same coherent
 * topic or line-of-work within a Project (e.g. "auth refactor", "billing
 * incident"). Sessions under the same Thread share Project-level shared
 * resources (memory, vaults, knowledge bases) but have independent actor
 * state, handoff history, and Run streams.
 *
 * Design §4 (`docs.local/sessions/ses_001-hierarchy-redesign/design.md`):
 *   - Container only. No own message stream, no own Run stream. Messages
 *     live in Sessions (Phase 0 decision B.1).
 *   - `title` is a user-facing label. **Titles are NOT unique within a
 *     Project.** Callers disambiguate by {@link ThreadId}; the title is
 *     freeform display text. If a product surface needs uniqueness (e.g.
 *     a human-typed slug), that constraint lives at the API layer, not in
 *     the kernel.
 *   - `ownerVersion` is the CAS counter for mutations — `updateThread` and
 *     archival transitions require a matching version and reject
 *     {@link StaleThreadError} on mismatch. Mirrors the
 *     {@link import('./session.js').Session} handoff CAS pattern (§6.1).
 *   - No fan-in `deriveStatus()` helper — status is owner-managed, not
 *     Run-derived. This is the Thread-vs-Session contract boundary.
 */
export interface Thread {
	id: ThreadId
	projectId: ProjectId
	tenantId: TenantId
	title: string
	status: ThreadStatus
	ownerVersion: number
	createdAt: Date
	updatedAt: Date
}
