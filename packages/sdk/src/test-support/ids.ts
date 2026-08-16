/**
 * Unchecked id constructors, for fixtures only.
 *
 * A test that needs three hundred distinct ids is not testing prefix
 * validation, and paying a `startsWith` per literal to say `ses_1` buys it
 * nothing. These are the cheap landing zone for that: same call shape as the
 * `as*Id` constructors in `utils/id.ts`, no check.
 *
 * **Deliberately NOT exported from the package barrel.** The whole value of
 * the checked constructors is that a malformed id cannot reach a store key,
 * and an unchecked one on the public surface is a supported way around that.
 * `test-support/` is reachable from inside this repo and nowhere else, which
 * is exactly the reach this needs.
 *
 * Two shapes rather than forty functions, because a fixture wants brevity:
 * `fixtureId.run('a')` reads at the call site, and `unchecked<RunId>(s)`
 * covers anything the table misses.
 */

import type {
	ActivityId,
	AdvisoryCallId,
	AdvisoryId,
	AgentId,
	AuditEventId,
	CheckpointId,
	ChunkId,
	ConnectorId,
	ConnectorInstanceId,
	CredentialId,
	DeliverableId,
	DocumentId,
	EmergencySaveId,
	EnvironmentId,
	ExecutionContextId,
	HandoffId,
	KnowledgeBaseId,
	KnowledgeBaseRef,
	LockId,
	MCPClientId,
	MCPServerId,
	MCPSessionId,
	MemoryId,
	MemoryStoreRef,
	MessageId,
	PlanId,
	PluginId,
	ProjectId,
	RunId,
	SandboxId,
	SessionId,
	SubSessionId,
	SummaryId,
	TaskId,
	TenantId,
	ToolCallId,
	TopicId,
	UserId,
	VaultRef,
	WorkspaceId,
} from '../types/ids/index.js'

/** Casts without checking. The name is the warning. */
export function unchecked<T extends string>(value: string): T {
	return value as T
}

/**
 * One entry per prefixed id type, keyed by the bare concept rather than the
 * type name — `fixtureId.run('a')`, not `fixtureId.RunId('a')`.
 */
export const fixtureId = {
	run: (suffix: string): RunId => `run_${suffix}`,
	message: (suffix: string): MessageId => `msg_${suffix}`,
	session: (suffix: string): SessionId => `ses_${suffix}`,
	toolCall: (suffix: string): ToolCallId => `call_${suffix}`,
	activity: (suffix: string): ActivityId => `act_${suffix}`,
	task: (suffix: string): TaskId => `task_${suffix}`,
	plan: (suffix: string): PlanId => `plan_${suffix}`,
	knowledgeBase: (suffix: string): KnowledgeBaseId => `kb_${suffix}`,
	document: (suffix: string): DocumentId => `doc_${suffix}`,
	chunk: (suffix: string): ChunkId => `chk_${suffix}`,
	connector: (suffix: string): ConnectorId => `conn_${suffix}`,
	connectorInstance: (suffix: string): ConnectorInstanceId => `ci_${suffix}`,
	tenant: (suffix: string): TenantId => `tnt_${suffix}`,
	credential: (suffix: string): CredentialId => `cred_${suffix}`,
	executionContext: (suffix: string): ExecutionContextId => `ectx_${suffix}`,
	mCPServer: (suffix: string): MCPServerId => `mcp_${suffix}`,
	mCPClient: (suffix: string): MCPClientId => `mcpc_${suffix}`,
	mCPSession: (suffix: string): MCPSessionId => `mcps_${suffix}`,
	environment: (suffix: string): EnvironmentId => `env_${suffix}`,
	checkpoint: (suffix: string): CheckpointId => `cp_${suffix}`,
	lock: (suffix: string): LockId => `lock_${suffix}`,
	advisory: (suffix: string): AdvisoryId => `adv_${suffix}`,
	advisoryCall: (suffix: string): AdvisoryCallId => `advc_${suffix}`,
	emergencySave: (suffix: string): EmergencySaveId => `esave_${suffix}`,
	memory: (suffix: string): MemoryId => `mem_${suffix}`,
	plugin: (suffix: string): PluginId => `plg_${suffix}`,
	sandbox: (suffix: string): SandboxId => `sbx_${suffix}`,
	auditEvent: (suffix: string): AuditEventId => `aud_${suffix}`,
	user: (suffix: string): UserId => `usr_${suffix}`,
	agent: (suffix: string): AgentId => `agt_${suffix}`,
	memoryStoreRef: (suffix: string): MemoryStoreRef => `mms_${suffix}`,
	vaultRef: (suffix: string): VaultRef => `vlt_${suffix}`,
	knowledgeBaseRef: (suffix: string): KnowledgeBaseRef => `kbs_${suffix}`,
	project: (suffix: string): ProjectId => `prj_${suffix}`,
	topic: (suffix: string): TopicId => `top_${suffix}`,
	subSession: (suffix: string): SubSessionId => `sub_${suffix}`,
	handoff: (suffix: string): HandoffId => `hof_${suffix}`,
	workspace: (suffix: string): WorkspaceId => `wsp_${suffix}`,
	summary: (suffix: string): SummaryId => `sum_${suffix}`,
	deliverable: (suffix: string): DeliverableId => `del_${suffix}`,
} as const
