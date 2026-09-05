import type { Id } from './brand.js'

/**
 * Entity ids are opaque branded strings. Factories mint UUIDs; checked
 * constructors reject every other spelling, including earlier type prefixes.
 * A RunId cannot be assigned to a SessionId even though their wire shapes
 * are identical. Persisted records and typed fields establish the kind,
 * not the spelling of the id.
 *
 * Brands do not validate a type assertion. Use the checked constructors
 * for values received from JSON, flags, URLs, or other untyped boundaries.
 */
export type RunId = Id<'RunId'>
export type MessageId = Id<'MessageId'>
export type SessionId = Id<'SessionId'>
/** Identifies one durable completion goal across its revisions. */
export type GoalId = Id<'GoalId'>
export type ToolCallId = Id<'ToolCallId'>
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
export type ActivityId = Id<'ActivityId'>
export type TaskId = Id<'TaskId'>
export type PlanId = Id<'PlanId'>
export type KnowledgeBaseId = Id<'KnowledgeBaseId'>
export type DocumentId = Id<'DocumentId'>
export type ChunkId = Id<'ChunkId'>
export type ConnectorId = Id<'ConnectorId'>
export type ConnectorInstanceId = Id<'ConnectorInstanceId'>
export type TenantId = Id<'TenantId'>
export type CredentialId = Id<'CredentialId'>
export type ExecutionContextId = Id<'ExecutionContextId'>
export type MCPServerId = Id<'MCPServerId'>
export type MCPClientId = Id<'MCPClientId'>
export type MCPSessionId = Id<'MCPSessionId'>
export type EnvironmentId = Id<'EnvironmentId'>
export type CheckpointId = Id<'CheckpointId'>
export type LockId = Id<'LockId'>
export type AdvisoryId = Id<'AdvisoryId'>
export type AdvisoryCallId = Id<'AdvisoryCallId'>
export type EmergencySaveId = Id<'EmergencySaveId'>
export type MemoryId = Id<'MemoryId'>
export type PluginId = Id<'PluginId'>
export type SandboxId = Id<'SandboxId'>
/** LOG-14: the audit trail's own record id — distinct from `RunEvent.seq`. */
export type AuditEventId = Id<'AuditEventId'>

// Actor identifiers (Session Hierarchy §4.3).
//
// This block used to say "branded so actor refs cannot be constructed from
// bare strings" while the compiler enforced nothing. NZ-SURF-11 made that
// true for `UserId`: `const a: UserId = 'usr_made-up'` is now an error.
export type UserId = Id<'UserId'>

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
 * and gets a warning. `asAgentId` is deprecated for the same reason: registry
 * keys have no entity-id spelling contract.
 */
export type AgentId = Id<'AgentId'>

// Shared-store placeholder refs (Session Hierarchy §4.2 / §3.2). Full shapes
// land in later phases; kept here as opaque branded IDs so ProjectConfig can
// reference them today.
export type MemoryStoreRef = Id<'MemoryStoreRef'>
export type VaultRef = Id<'VaultRef'>
export type KnowledgeBaseRef = Id<'KnowledgeBaseRef'>

// Session hierarchy identities; types/session/ids.ts re-exports these.
export type ProjectId = Id<'ProjectId'>
/**
 * A topic is distinct from its project; each carries its own opaque UUID.
 */
export type TopicId = Id<'TopicId'>
export type SubSessionId = Id<'SubSessionId'>
export type HandoffId = Id<'HandoffId'>
export type WorkspaceId = Id<'WorkspaceId'>
export type SummaryId = Id<'SummaryId'>
export type DeliverableId = Id<'DeliverableId'>

/**
 * @deprecated All prefixed IDs are rejected by InvalidIdError. This error
 * remains exported for callers that referenced the earlier exception type.
 */
export class RetiredIdPrefixError extends Error {
	constructor(
		readonly value: string,
		readonly expectedPrefix: string,
	) {
		super(
			`Retired id prefix: ${JSON.stringify(value)} is not a ${JSON.stringify(expectedPrefix)} id. Records written by namzu before 0.2 are not read by this version; open them with a 0.x namzu that migrates them, or start fresh.`,
		)
		this.name = 'RetiredIdPrefixError'
	}
}
