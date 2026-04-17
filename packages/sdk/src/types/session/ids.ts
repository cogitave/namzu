/**
 * Session hierarchy branded ID re-export barrel.
 *
 * Canonical definitions live in `../ids/index.ts` (Phase 9 Known Delta #4
 * collapse: previously this file declared ProjectId/SubSessionId/etc. and
 * `types/ids/` re-exported them — a circular re-export that TypeScript
 * resolved cleanly but smelled). All session IDs now live in one place;
 * this barrel exists solely for ergonomic co-location with session-scoped
 * callers (they already import from `types/session/`).
 */

export type {
	ProjectId,
	SubSessionId,
	HandoffId,
	WorkspaceId,
	SummaryId,
	DeliverableId,
	SessionId,
	TenantId,
	RunId,
	AgentId,
	UserId,
	TaskId,
	ThreadId,
} from '../ids/index.js'

import type { ProjectId } from '../ids/index.js'

/**
 * @deprecated Use {@link ProjectId}. Alias kept for one version migration
 * window; scheduled for removal in 0.3.0 per session-hierarchy.md §13.3.1.
 */
export type ThreadIdDeprecated = ProjectId
