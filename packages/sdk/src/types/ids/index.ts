export type RunId = `run_${string}`
export type MessageId = `msg_${string}`
export type SessionId = `ses_${string}`
export type ToolCallId = `call_${string}`
/**
 * Provider-issued tool-use identifier surfaced on the streaming event bus.
 * Providers emit different prefixes (`toolu_*`, `call_*`,
 * others vary), so this type intentionally stays unbranded — we accept the
 * provider's verbatim string and use it solely as a correlation key across
 * `tool_input_*`, `tool_executing`, and `tool_completed` events. Distinct
 * from {@link ToolCallId} which is the wire-format identifier carried in
 * persisted assistant messages and replay records.
 */
export type ToolUseId = string
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
/** LOG-14: the audit trail's own record id — distinct from `RunEvent.seq`. */
export type AuditEventId = `aud_${string}`

// Actor identifiers (Session Hierarchy §4.3).
//
// This said "branded so actor refs cannot be constructed from bare strings",
// and the compiler does not enforce that. Every id here is a bare
// template-literal type, and TypeScript makes any matching string literal
// assignable to one with no cast and no factory call — so
// `const a: AgentId = 'agt_made-up'` compiles and is indistinguishable from
// an id `generateAgentId()` minted. The sentence was a claim a test could
// falsify, sitting in the source as documentation.
//
// What IS enforced today: the `as*Id` constructors in `utils/id.ts` check
// the prefix at runtime and throw `InvalidIdError` otherwise. That is a
// check a caller has to opt into, not a property of the type.
//
// The machinery to make the types nominal is in `./brand.ts`, unapplied —
// flipping it turns every existing bare literal into an error at once, which
// is a `major` with a migration in front of it.
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
/**
 * NZ-TOPIC-04: narrowed from the NZ-TOPIC-01 alias `type TopicId = ThreadId`
 * (both `thd_${string}`) to its own prefix. `thd_` from here on means only
 * the pre-0.2.0 top-level container (`session/migration/id-prefix.ts`,
 * `session/migration/filesystem.ts`) -- a meaning `ThreadId` never carried;
 * it was purely the deprecated name for THIS type. Deleted rather than
 * repurposed to mean the legacy container instead: a name whose meaning
 * silently changes under unmigrated callers is worse than a name that is
 * gone (Convention #0, no silent long-lived compat).
 */
export type TopicId = `top_${string}`
/**
 * @deprecated Use {@link TopicId}. Removal is NZ-TOPIC-05.
 *
 * NZ-TOPIC-01 introduced `TopicId` as an alias OF this name; NZ-TOPIC-04
 * reverses the direction. So this alias now follows `TopicId` to the `top_`
 * prefix instead of keeping `thd_` — a consumer still compiling against the
 * old name gets the new prefix, which is exactly what the major announces.
 *
 * It is kept rather than deleted because the deprecation NZ-TOPIC-01 wrote
 * has never reached a registry: `@namzu/sdk` on npm is 27.1.0, and the
 * changeset that would publish it is still unconsumed in `.changeset/`. A
 * removal here would be a rename with no alias wearing a major's clothes.
 * This release is the one that carries the warning; the next may remove it.
 */
export type ThreadId = TopicId
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
