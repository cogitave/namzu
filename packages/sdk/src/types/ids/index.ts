export type RunId = `run_${string}`
export type MessageId = `msg_${string}`
export type SessionId = `ses_${string}`
export type ToolCallId = `call_${string}`
export type ActivityId = `act_${string}`
export type TaskId = `task_${string}`
export type PlanId = `plan_${string}`
export type KnowledgeBaseId = `kb_${string}`
export type DocumentId = `doc_${string}`
export type ChunkId = `chk_${string}`
export type ConnectorId = `conn_${string}`
export type ConnectorInstanceId = `ci_${string}`
export type TenantId = `tnt_${string}`
export type CredentialId = `cred_${string}`
export type ExecutionContextId = `ectx_${string}`
export type MCPServerId = `mcp_${string}`
export type MCPClientId = `mcpc_${string}`
export type MCPSessionId = `mcps_${string}`
export type EnvironmentId = `env_${string}`
export type CheckpointId = `cp_${string}`
export type LockId = `lock_${string}`
export type AdvisoryId = `adv_${string}`
export type AdvisoryCallId = `advc_${string}`
export type EmergencySaveId = `esave_${string}`
export type MemoryId = `mem_${string}`
export type PluginId = `plg_${string}`
export type SandboxId = `sbx_${string}`

// Actor identifiers (Session Hierarchy §4.3). Branded so actor refs cannot be
// constructed from bare strings.
export type UserId = `usr_${string}`
export type AgentId = `agt_${string}`

// Shared-store placeholder refs (Session Hierarchy §4.2 / §3.2). Full shapes
// land in later phases; kept here as opaque branded IDs so ProjectConfig can
// reference them today.
export type MemoryStoreRef = `mms_${string}`
export type VaultRef = `vlt_${string}`
export type KnowledgeBaseRef = `kbs_${string}`

// Session hierarchy IDs are defined in `../session/ids.ts`; re-exported here
// for ergonomic access from modules that already import from `types/ids/`.
export type {
	ProjectId,
	SubSessionId,
	HandoffId,
	WorkspaceId,
	SummaryId,
	DeliverableId,
} from '../session/ids.js'

import type { ProjectId } from '../session/ids.js'

/**
 * @deprecated Use {@link ProjectId}. Alias retained for the 0.2.x migration
 * window; will be removed in 0.3.0. See session-hierarchy.md §13.3.1.
 */
export type ThreadId = ProjectId

/**
 * Sentinel {@link TenantId} for legacy pre-0.2.0 runs rehomed by the
 * boot-time filesystem migration (session-hierarchy.md §13.4.1). Consumers
 * with strict tenant enforcement should either tag these records on first
 * access or reject them until a real tenant is assigned — the kernel
 * surfaces the sentinel but does not prescribe policy (Convention #17).
 */
export const UNKNOWN_TENANT_ID = 'tnt_unknown_legacy' as TenantId
