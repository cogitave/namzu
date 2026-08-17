import { type Id, unsafeId } from './brand.js'

/**
 * Every id here is NOMINAL as of NZ-SURF-11: `Id<Prefix, Tag>` intersects the
 * wire shape with a unique-symbol brand, so `const a: RunId = 'run_x'` no
 * longer compiles and neither does handing a `SessionId` where a `RunId` was
 * asked for. Ids are minted by `generate*Id()` or checked by `as*Id()` in
 * `utils/id.ts`; fixtures use `test-support/ids.ts`.
 *
 * **What this does NOT stop, measured rather than assumed:** a type
 * ASSERTION. `'run_x' as RunId` and `someString as RunId` both still compile,
 * because TypeScript's assertion rule only asks that the two types be
 * comparable and a string is comparable to a branded string. The brand makes
 * a rule against `as <IdType>` enforceable — it does not replace one. See
 * `__tests__/an-id-is-not-a-string.test.ts`, which pins both halves.
 */
export type RunId = Id<'run', 'RunId'>
export type MessageId = Id<'msg', 'MessageId'>
export type SessionId = Id<'ses', 'SessionId'>
export type ToolCallId = Id<'call', 'ToolCallId'>
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
export type ActivityId = Id<'act', 'ActivityId'>
export type TaskId = Id<'task', 'TaskId'>
export type PlanId = Id<'plan', 'PlanId'>
export type KnowledgeBaseId = Id<'kb', 'KnowledgeBaseId'>
export type DocumentId = Id<'doc', 'DocumentId'>
export type ChunkId = Id<'chk', 'ChunkId'>
export type ConnectorId = Id<'conn', 'ConnectorId'>
export type ConnectorInstanceId = Id<'ci', 'ConnectorInstanceId'>
export type TenantId = Id<'tnt', 'TenantId'>
export type CredentialId = Id<'cred', 'CredentialId'>
export type ExecutionContextId = Id<'ectx', 'ExecutionContextId'>
export type MCPServerId = Id<'mcp', 'MCPServerId'>
export type MCPClientId = Id<'mcpc', 'MCPClientId'>
export type MCPSessionId = Id<'mcps', 'MCPSessionId'>
export type EnvironmentId = Id<'env', 'EnvironmentId'>
export type CheckpointId = Id<'cp', 'CheckpointId'>
export type LockId = Id<'lock', 'LockId'>
export type AdvisoryId = Id<'adv', 'AdvisoryId'>
export type AdvisoryCallId = Id<'advc', 'AdvisoryCallId'>
export type EmergencySaveId = Id<'esave', 'EmergencySaveId'>
export type MemoryId = Id<'mem', 'MemoryId'>
export type PluginId = Id<'plg', 'PluginId'>
export type SandboxId = Id<'sbx', 'SandboxId'>
/** LOG-14: the audit trail's own record id — distinct from `RunEvent.seq`. */
export type AuditEventId = Id<'aud', 'AuditEventId'>

// Actor identifiers (Session Hierarchy §4.3).
//
// This block used to say "branded so actor refs cannot be constructed from
// bare strings" while the compiler enforced nothing. NZ-SURF-11 made that
// true for `UserId`: `const a: UserId = 'usr_made-up'` is now an error.
export type UserId = Id<'usr', 'UserId'>

/**
 * @deprecated An agent is identified by its REGISTRY KEY, and this type
 * never described one. Removal is a later major.
 *
 * `ActorRef.agentId` was annotated `AgentId` and every value that ever
 * reached it was a key an operator chose — `'worker'`, `'reviewer'`,
 * `'supervisor'` — reaching the field through an `as AgentId` cast. There is
 * no producer: nothing in this kernel has ever called `generateAgentId`
 * (there isn't one), so an `agt_`-prefixed agent identifier has never
 * existed. NZ-SURF-11 changed `ActorRef.agentId` to `string`, which is what
 * it always held.
 *
 * Kept for one release rather than deleted, per the deprecate-before-remove
 * rule: a consumer that annotated its own variable `AgentId` still compiles
 * and gets a warning. `asAgentId` is deprecated for the same reason and
 * would throw on every value the kernel actually produces.
 */
export type AgentId = Id<'agt', 'AgentId'>

// Shared-store placeholder refs (Session Hierarchy §4.2 / §3.2). Full shapes
// land in later phases; kept here as opaque branded IDs so ProjectConfig can
// reference them today.
export type MemoryStoreRef = Id<'mms', 'MemoryStoreRef'>
export type VaultRef = Id<'vlt', 'VaultRef'>
export type KnowledgeBaseRef = Id<'kbs', 'KnowledgeBaseRef'>

// Session hierarchy IDs. Convention #2 branded IDs; prefixes mandated by the
// five-layer hierarchy (Project → Thread → Session → SubSession → Run). The
// `types/session/ids.ts` barrel re-exports these for co-location ergonomics.
export type ProjectId = Id<'prj', 'ProjectId'>
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
export type TopicId = Id<'top', 'TopicId'>
export type SubSessionId = Id<'sub', 'SubSessionId'>
export type HandoffId = Id<'hof', 'HandoffId'>
export type WorkspaceId = Id<'wsp', 'WorkspaceId'>
export type SummaryId = Id<'sum', 'SummaryId'>
export type DeliverableId = Id<'del', 'DeliverableId'>

/**
 * Sentinel {@link TenantId} for legacy pre-0.2.0 runs rehomed by the
 * boot-time filesystem migration. Consumers with strict tenant enforcement
 * should either tag these records on first access or reject them until a
 * real tenant is assigned — the kernel surfaces the sentinel but does not
 * prescribe policy (Convention #17).
 */
// `unsafeId`, not `asTenantId`: `utils/id.ts` imports this file, so reaching
// for its constructor here would close a cycle. The prefix is pinned by
// `__tests__/an-id-is-not-a-string.test.ts` instead.
export const UNKNOWN_TENANT_ID = unsafeId<TenantId>('tnt_unknown_legacy')
