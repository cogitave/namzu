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

/**
 * Stable identity of one HITL decision request, minted when the request is put
 * to a reviewer and unchanged across every re-emission of that same request. A
 * durable pause that re-emitted a fresh id on every resume would make an
 * idempotent client answer the same question twice.
 */
export type DecisionRequestId = `dreq_${string}`

/**
 * Opaque, single-use capability that identifies one paused decision and permits
 * it to be answered. Scoped to (run, request); redeeming it invalidates it.
 *
 * **A token is necessary, never sufficient.** Possession does not authorize:
 * the route that accepts a decision still has to establish that the caller owns
 * the run. n8n's Ni8mare (CVE-2026-21858) is in exactly this threat class — the
 * endpoint that resumes a paused execution is a real, exploited attack surface,
 * and a leaked resume token must not BE an authorization. For the same reason
 * the token is never emitted on the run's event stream: an event stream is a
 * broadcast, and a capability broadcast to every subscriber is not a capability.
 * It lives on the checkpoint, and an authorized server-side reader hands it to
 * whoever is entitled to answer.
 */
export type ResumeToken = `rt_${string}`
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

// Session hierarchy IDs. Convention #2 branded IDs; prefixes mandated by the
// five-layer hierarchy (Project → Thread → Session → SubSession → Run). The
// `types/session/ids.ts` barrel re-exports these for co-location ergonomics.
export type ProjectId = `prj_${string}`
export type ThreadId = `thd_${string}`
export type SubSessionId = `sub_${string}`
export type HandoffId = `hof_${string}`
export type WorkspaceId = `wsp_${string}`
export type SummaryId = `sum_${string}`
export type DeliverableId = `del_${string}`

/**
 * Sentinel {@link TenantId} for legacy pre-0.2.0 runs rehomed by the
 * boot-time filesystem migration. Consumers with strict tenant enforcement
 * should either tag these records on first access or reject them until a
 * real tenant is assigned — the kernel surfaces the sentinel but does not
 * prescribe policy (Convention #17).
 */
export const UNKNOWN_TENANT_ID = 'tnt_unknown_legacy' as TenantId
