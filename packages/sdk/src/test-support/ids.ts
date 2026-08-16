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

import { unsafeId } from '../types/ids/brand.js'
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
	return unsafeId<T>(value)
}

/**
 * One entry per prefixed id type, keyed by the bare concept rather than the
 * type name — `fixtureId.run('a')`, not `fixtureId.RunId('a')`.
 */
export const fixtureId = {
	run: (suffix: string): RunId => unsafeId<RunId>(`run_${suffix}`),
	message: (suffix: string): MessageId => unsafeId<MessageId>(`msg_${suffix}`),
	session: (suffix: string): SessionId => unsafeId<SessionId>(`ses_${suffix}`),
	toolCall: (suffix: string): ToolCallId => unsafeId<ToolCallId>(`call_${suffix}`),
	activity: (suffix: string): ActivityId => unsafeId<ActivityId>(`act_${suffix}`),
	task: (suffix: string): TaskId => unsafeId<TaskId>(`task_${suffix}`),
	plan: (suffix: string): PlanId => unsafeId<PlanId>(`plan_${suffix}`),
	knowledgeBase: (suffix: string): KnowledgeBaseId => unsafeId<KnowledgeBaseId>(`kb_${suffix}`),
	document: (suffix: string): DocumentId => unsafeId<DocumentId>(`doc_${suffix}`),
	chunk: (suffix: string): ChunkId => unsafeId<ChunkId>(`chk_${suffix}`),
	connector: (suffix: string): ConnectorId => unsafeId<ConnectorId>(`conn_${suffix}`),
	connectorInstance: (suffix: string): ConnectorInstanceId =>
		unsafeId<ConnectorInstanceId>(`ci_${suffix}`),
	tenant: (suffix: string): TenantId => unsafeId<TenantId>(`tnt_${suffix}`),
	credential: (suffix: string): CredentialId => unsafeId<CredentialId>(`cred_${suffix}`),
	executionContext: (suffix: string): ExecutionContextId =>
		unsafeId<ExecutionContextId>(`ectx_${suffix}`),
	mCPServer: (suffix: string): MCPServerId => unsafeId<MCPServerId>(`mcp_${suffix}`),
	mCPClient: (suffix: string): MCPClientId => unsafeId<MCPClientId>(`mcpc_${suffix}`),
	mCPSession: (suffix: string): MCPSessionId => unsafeId<MCPSessionId>(`mcps_${suffix}`),
	environment: (suffix: string): EnvironmentId => unsafeId<EnvironmentId>(`env_${suffix}`),
	checkpoint: (suffix: string): CheckpointId => unsafeId<CheckpointId>(`cp_${suffix}`),
	lock: (suffix: string): LockId => unsafeId<LockId>(`lock_${suffix}`),
	advisory: (suffix: string): AdvisoryId => unsafeId<AdvisoryId>(`adv_${suffix}`),
	advisoryCall: (suffix: string): AdvisoryCallId => unsafeId<AdvisoryCallId>(`advc_${suffix}`),
	emergencySave: (suffix: string): EmergencySaveId => unsafeId<EmergencySaveId>(`esave_${suffix}`),
	memory: (suffix: string): MemoryId => unsafeId<MemoryId>(`mem_${suffix}`),
	plugin: (suffix: string): PluginId => unsafeId<PluginId>(`plg_${suffix}`),
	sandbox: (suffix: string): SandboxId => unsafeId<SandboxId>(`sbx_${suffix}`),
	auditEvent: (suffix: string): AuditEventId => unsafeId<AuditEventId>(`aud_${suffix}`),
	user: (suffix: string): UserId => unsafeId<UserId>(`usr_${suffix}`),
	agent: (suffix: string): AgentId => unsafeId<AgentId>(`agt_${suffix}`),
	memoryStoreRef: (suffix: string): MemoryStoreRef => unsafeId<MemoryStoreRef>(`mms_${suffix}`),
	vaultRef: (suffix: string): VaultRef => unsafeId<VaultRef>(`vlt_${suffix}`),
	knowledgeBaseRef: (suffix: string): KnowledgeBaseRef =>
		unsafeId<KnowledgeBaseRef>(`kbs_${suffix}`),
	project: (suffix: string): ProjectId => unsafeId<ProjectId>(`prj_${suffix}`),
	topic: (suffix: string): TopicId => unsafeId<TopicId>(`top_${suffix}`),
	subSession: (suffix: string): SubSessionId => unsafeId<SubSessionId>(`sub_${suffix}`),
	handoff: (suffix: string): HandoffId => unsafeId<HandoffId>(`hof_${suffix}`),
	workspace: (suffix: string): WorkspaceId => unsafeId<WorkspaceId>(`wsp_${suffix}`),
	summary: (suffix: string): SummaryId => unsafeId<SummaryId>(`sum_${suffix}`),
	deliverable: (suffix: string): DeliverableId => unsafeId<DeliverableId>(`del_${suffix}`),
} as const
