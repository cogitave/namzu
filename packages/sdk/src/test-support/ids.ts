/** Deterministic UUID fixtures. Deliberately absent from the package barrel. */

import { createHash } from 'node:crypto'
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

/** Maps a readable fixture label to a stable, valid UUID without global state. */
export function fixtureUuid(label: string): string {
	const bytes = createHash('sha256').update(label).digest().subarray(0, 16)
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
	const hex = bytes.toString('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * One entry per entity type, keyed by the bare concept rather than the
 * type name — `fixtureId.run('a')`, not `fixtureId.RunId('a')`.
 */
export const fixtureId = {
	run: (suffix: string): RunId => unsafeId<RunId>(fixtureUuid(`run_${suffix}`)),
	message: (suffix: string): MessageId => unsafeId<MessageId>(fixtureUuid(`msg_${suffix}`)),
	session: (suffix: string): SessionId => unsafeId<SessionId>(fixtureUuid(`ses_${suffix}`)),
	toolCall: (suffix: string): ToolCallId => unsafeId<ToolCallId>(fixtureUuid(`call_${suffix}`)),
	activity: (suffix: string): ActivityId => unsafeId<ActivityId>(fixtureUuid(`act_${suffix}`)),
	task: (suffix: string): TaskId => unsafeId<TaskId>(fixtureUuid(`task_${suffix}`)),
	plan: (suffix: string): PlanId => unsafeId<PlanId>(fixtureUuid(`plan_${suffix}`)),
	knowledgeBase: (suffix: string): KnowledgeBaseId =>
		unsafeId<KnowledgeBaseId>(fixtureUuid(`kb_${suffix}`)),
	document: (suffix: string): DocumentId => unsafeId<DocumentId>(fixtureUuid(`doc_${suffix}`)),
	chunk: (suffix: string): ChunkId => unsafeId<ChunkId>(fixtureUuid(`chk_${suffix}`)),
	connector: (suffix: string): ConnectorId => unsafeId<ConnectorId>(fixtureUuid(`conn_${suffix}`)),
	connectorInstance: (suffix: string): ConnectorInstanceId =>
		unsafeId<ConnectorInstanceId>(fixtureUuid(`ci_${suffix}`)),
	tenant: (suffix: string): TenantId => unsafeId<TenantId>(fixtureUuid(`tnt_${suffix}`)),
	credential: (suffix: string): CredentialId =>
		unsafeId<CredentialId>(fixtureUuid(`cred_${suffix}`)),
	executionContext: (suffix: string): ExecutionContextId =>
		unsafeId<ExecutionContextId>(fixtureUuid(`ectx_${suffix}`)),
	mCPServer: (suffix: string): MCPServerId => unsafeId<MCPServerId>(fixtureUuid(`mcp_${suffix}`)),
	mCPClient: (suffix: string): MCPClientId => unsafeId<MCPClientId>(fixtureUuid(`mcpc_${suffix}`)),
	mCPSession: (suffix: string): MCPSessionId =>
		unsafeId<MCPSessionId>(fixtureUuid(`mcps_${suffix}`)),
	environment: (suffix: string): EnvironmentId =>
		unsafeId<EnvironmentId>(fixtureUuid(`env_${suffix}`)),
	checkpoint: (suffix: string): CheckpointId => unsafeId<CheckpointId>(fixtureUuid(`cp_${suffix}`)),
	lock: (suffix: string): LockId => unsafeId<LockId>(fixtureUuid(`lock_${suffix}`)),
	advisory: (suffix: string): AdvisoryId => unsafeId<AdvisoryId>(fixtureUuid(`adv_${suffix}`)),
	advisoryCall: (suffix: string): AdvisoryCallId =>
		unsafeId<AdvisoryCallId>(fixtureUuid(`advc_${suffix}`)),
	emergencySave: (suffix: string): EmergencySaveId =>
		unsafeId<EmergencySaveId>(fixtureUuid(`esave_${suffix}`)),
	memory: (suffix: string): MemoryId => unsafeId<MemoryId>(fixtureUuid(`mem_${suffix}`)),
	plugin: (suffix: string): PluginId => unsafeId<PluginId>(fixtureUuid(`plg_${suffix}`)),
	sandbox: (suffix: string): SandboxId => unsafeId<SandboxId>(fixtureUuid(`sbx_${suffix}`)),
	auditEvent: (suffix: string): AuditEventId =>
		unsafeId<AuditEventId>(fixtureUuid(`aud_${suffix}`)),
	user: (suffix: string): UserId => unsafeId<UserId>(fixtureUuid(`usr_${suffix}`)),
	agent: (suffix: string): AgentId => unsafeId<AgentId>(fixtureUuid(`agt_${suffix}`)),
	memoryStoreRef: (suffix: string): MemoryStoreRef =>
		unsafeId<MemoryStoreRef>(fixtureUuid(`mms_${suffix}`)),
	vaultRef: (suffix: string): VaultRef => unsafeId<VaultRef>(fixtureUuid(`vlt_${suffix}`)),
	knowledgeBaseRef: (suffix: string): KnowledgeBaseRef =>
		unsafeId<KnowledgeBaseRef>(fixtureUuid(`kbs_${suffix}`)),
	project: (suffix: string): ProjectId => unsafeId<ProjectId>(fixtureUuid(`prj_${suffix}`)),
	topic: (suffix: string): TopicId => unsafeId<TopicId>(fixtureUuid(`top_${suffix}`)),
	subSession: (suffix: string): SubSessionId =>
		unsafeId<SubSessionId>(fixtureUuid(`sub_${suffix}`)),
	handoff: (suffix: string): HandoffId => unsafeId<HandoffId>(fixtureUuid(`hof_${suffix}`)),
	workspace: (suffix: string): WorkspaceId => unsafeId<WorkspaceId>(fixtureUuid(`wsp_${suffix}`)),
	summary: (suffix: string): SummaryId => unsafeId<SummaryId>(fixtureUuid(`sum_${suffix}`)),
	deliverable: (suffix: string): DeliverableId =>
		unsafeId<DeliverableId>(fixtureUuid(`del_${suffix}`)),
} as const
