/**
 * Session hierarchy branded IDs.
 *
 * Follows Convention #2 (`<prefix>_<opaque>` template literal brands) and
 * matches the prefixes mandated by session-hierarchy.md §4.
 */

export type ProjectId = `prj_${string}`
export type SubSessionId = `sub_${string}`
export type HandoffId = `hof_${string}`
export type WorkspaceId = `wsp_${string}`
export type SummaryId = `sum_${string}`
export type DeliverableId = `del_${string}`

// Re-exported for co-location convenience. Callers living under `session/`
// should import tenancy / session / run / agent / task / thread ids from
// here rather than reaching into `types/ids/`.
export type {
	SessionId,
	TenantId,
	RunId,
	AgentId,
	UserId,
	TaskId,
	ThreadId,
} from '../ids/index.js'

/**
 * @deprecated Use {@link ProjectId}. Alias kept for one version migration
 * window; scheduled for removal in 0.3.0 per session-hierarchy.md §13.3.1.
 */
export type ThreadIdDeprecated = ProjectId
