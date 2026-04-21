import type { TenantId } from '../ids/index.js'
import type { ProjectId, ThreadId } from '../session/ids.js'

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
 * {@link import('./ids.js').SessionId Session} in the five-layer hierarchy
 * (Project → Thread → Session → SubSession → Run).
 *
 * A Thread groups together many Sessions that address the same coherent
 * topic or line-of-work within a Project (e.g. "auth refactor", "billing
 * incident"). Sessions under the same Thread share Project-level shared
 * resources (memory, vaults, knowledge bases) but have independent actor
 * state, handoff history, and Run streams.
 *
 * ## Why Thread is a first-class layer (A2A-connection surface)
 *
 * The layer exists because of how enterprise sharing works in Namzu:
 *
 * - **Project is the folder-bound sharing unit.** An enterprise team shares
 *   a Project (`.namzu/` in a repo, a long-lived goal scope). Everyone with
 *   Project access sees its shape but not necessarily its active work.
 * - **Thread is the path-independent, A2A-attachable topic surface.** A
 *   Project can have multiple Threads — one per objective or line-of-work —
 *   and the Threads can be partitioned by device, user, or agent identity.
 *   A2A (agent-to-agent) connections attach at the Thread level: connecting
 *   to a Thread exposes every Session under it and the ability to join the
 *   ongoing work.
 * - **Sessions are the immediate work unit.** A user or agent enters a
 *   Thread and opens/resumes Sessions for the concrete interval of work.
 *
 * This is the mental model ses_001 ratified (Phase 0, 2026-04-18). Industry
 * frameworks (OpenAI Responses, LangGraph, Claude Agent SDK, Temporal) do
 * not have an exact analogue for the Thread layer — it is Namzu's answer to
 * the question "how do you expose a multi-session topic to A2A without
 * coupling it to the Project's filesystem identity?".
 *
 * ## Design reference
 *
 * Session design §4 (`docs.local/sessions/ses_001-hierarchy-redesign/design.md`):
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
 *     {@link import('./entity.js').Session} handoff CAS pattern (§6.1).
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
