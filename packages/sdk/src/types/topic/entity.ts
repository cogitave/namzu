import type { TenantId } from '../ids/index.js'
import type { ProjectId, TopicId } from '../session/ids.js'

/**
 * Lifecycle state of a Topic.
 *
 * - `open` — accepts new Sessions and new Runs under existing Sessions.
 * - `archived` — read-only tombstone. No new Sessions may be created; existing
 *   Sessions remain navigable. Transitioning `open → archived` requires that
 *   no Session under the Topic is in a non-terminal state (guarded at the
 *   store level by listing + status fan-in).
 *
 * There is no `active` variant — Topic does NOT derive status from its child
 * Sessions the way a Session does from its Runs. Topic is a pure container
 * (Phase 0 decision B.1: Topic is container-only, no message stream, no
 * fan-in). Its status is an explicit owner action.
 */
export type TopicStatus = 'open' | 'archived'

/**
 * Topic-level container sitting between {@link ProjectId Project} and
 * {@link import('../session/ids.js').SessionId Session} in the five-layer hierarchy
 * (Project → Topic → Session → SubSession → Run).
 *
 * NZ-TOPIC-01 renamed this entity from `Thread` to `Topic` — its own docstring
 * already called it a "Topic-level container" before the identifier caught up.
 * NZ-TOPIC-04 narrows the exported {@link import('../ids/index.js').TopicId}
 * from the pre-0.2.0 `thd_` shape to `top_`; on-disk records written under
 * the old prefix are migrated on read (`store/session/disk.ts`).
 *
 * A Topic groups together many Sessions that address the same coherent
 * topic or line-of-work within a Project (e.g. "auth refactor", "billing
 * incident"). Sessions under the same Topic share Project-level shared
 * resources (memory, vaults, knowledge bases) but have independent actor
 * state, handoff history, and Run streams.
 *
 * ## Why Topic is a first-class layer (A2A-connection surface)
 *
 * The layer exists because of how enterprise sharing works in Namzu:
 *
 * - **Project is the folder-bound sharing unit.** An enterprise team shares
 *   a Project (`.namzu/` in a repo, a long-lived goal scope). Everyone with
 *   Project access sees its shape but not necessarily its active work.
 * - **Topic is the path-independent, A2A-attachable topic surface.** A
 *   Project can have multiple Topics — one per objective or line-of-work —
 *   and the Topics can be partitioned by device, user, or agent identity.
 *   A2A (agent-to-agent) connections attach at the Topic level: connecting
 *   to a Topic exposes every Session under it and the ability to join the
 *   ongoing work.
 * - **Sessions are the immediate work unit.** A user or agent enters a
 *   Topic and opens/resumes Sessions for the concrete interval of work.
 *
 * This is the mental model ses_001 ratified (Phase 0, 2026-04-18). The
 * Topic layer has no counterpart elsewhere — it is Namzu's answer to
 * the question "how do you expose a multi-session topic to A2A without
 * coupling it to the Project's filesystem identity?".
 *
 * ## Design reference
 *
 * Session design §4 (ratified in ses_001-hierarchy-redesign):
 *   - Container only. No own message stream, no own Run stream. Messages
 *     live in Sessions (Phase 0 decision B.1).
 *   - `title` is a user-facing label. **Titles are NOT unique within a
 *     Project.** Callers disambiguate by {@link TopicId}; the title is
 *     freeform display text. If a product surface needs uniqueness (e.g.
 *     a human-typed slug), that constraint lives at the API layer, not in
 *     the kernel.
 *   - `ownerVersion` is the CAS counter for mutations — `updateTopic` and
 *     archival transitions require a matching version and reject
 *     {@link import('../../session/errors.js').StaleThreadError} on mismatch
 *     (error class name is unchanged this release — see NZ-TOPIC-01 risks).
 *     Mirrors the {@link import('./entity.js').Session} handoff CAS pattern
 *     (§6.1).
 *   - No fan-in `deriveStatus()` helper — status is owner-managed, not
 *     Run-derived. This is the Topic-vs-Session contract boundary.
 */
export interface Topic {
	id: TopicId
	projectId: ProjectId
	tenantId: TenantId
	title: string
	status: TopicStatus
	ownerVersion: number
	createdAt: Date
	updatedAt: Date
}
