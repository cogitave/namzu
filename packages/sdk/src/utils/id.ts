import { randomUUID } from 'node:crypto'
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
	GoalId,
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
import { entityIdPattern } from './id-format.js'

/** Factories supply the nominal type; the wire identity carries no kind. */
function generateId<T extends string>(): T {
	return unsafeId<T>(randomUUID())
}

export function generateProjectId(): ProjectId {
	return generateId()
}

export function generateTopicId(): TopicId {
	return generateId()
}

export function generateRunId(): RunId {
	return generateId()
}

export function generateMessageId(): MessageId {
	return generateId()
}

export function generateSessionId(): SessionId {
	return generateId()
}

export function generateGoalId(): GoalId {
	return generateId()
}

export function generateToolCallId(): ToolCallId {
	return generateId()
}

export function generateActivityId(): ActivityId {
	return generateId()
}

export function generateTaskId(): TaskId {
	return generateId()
}

export function generatePlanId(): PlanId {
	return generateId()
}

export function generateKnowledgeBaseId(): KnowledgeBaseId {
	return generateId()
}

export function generateDocumentId(): DocumentId {
	return generateId()
}

export function generateChunkId(): ChunkId {
	return generateId()
}

export function generateConnectorId(): ConnectorId {
	return generateId()
}

export function generateConnectorInstanceId(): ConnectorInstanceId {
	return generateId()
}

export function generateTenantId(): TenantId {
	return generateId()
}

export function generateCredentialId(): CredentialId {
	return generateId()
}

export function generateExecutionContextId(): ExecutionContextId {
	return generateId()
}

export function generateMCPServerId(): MCPServerId {
	return generateId()
}

export function generateMCPClientId(): MCPClientId {
	return generateId()
}

export function generateMCPSessionId(): MCPSessionId {
	return generateId()
}

export function generateEnvironmentId(): EnvironmentId {
	return generateId()
}

export function generateCheckpointId(): CheckpointId {
	return generateId()
}

export function generateAdvisoryId(): AdvisoryId {
	return generateId()
}

export function generateAdvisoryCallId(): AdvisoryCallId {
	return generateId()
}

export function generateAuditEventId(): AuditEventId {
	return generateId()
}

export function generateEmergencySaveId(): EmergencySaveId {
	return generateId()
}

export function generateMemoryId(): MemoryId {
	return generateId()
}

export function generatePluginId(): PluginId {
	return generateId()
}

export function generateSandboxId(): SandboxId {
	return generateId()
}

export function generateWorkspaceId(): WorkspaceId {
	return generateId()
}

export function generateSubSessionId(): SubSessionId {
	return generateId()
}

export function generateSummaryId(): SummaryId {
	return generateId()
}

export function generateHandoffId(): HandoffId {
	return generateId()
}

export function generateDeliverableId(): DeliverableId {
	return generateId()
}

/** Entity kinds are supplied by a typed field or storage collection. */
export interface EntityIdByKind {
	run: RunId
	message: MessageId
	session: SessionId
	goal: GoalId
	toolCall: ToolCallId
	activity: ActivityId
	task: TaskId
	plan: PlanId
	knowledgeBase: KnowledgeBaseId
	document: DocumentId
	chunk: ChunkId
	connector: ConnectorId
	connectorInstance: ConnectorInstanceId
	tenant: TenantId
	credential: CredentialId
	executionContext: ExecutionContextId
	mcpServer: MCPServerId
	mcpClient: MCPClientId
	mcpSession: MCPSessionId
	environment: EnvironmentId
	checkpoint: CheckpointId
	lock: LockId
	advisory: AdvisoryId
	advisoryCall: AdvisoryCallId
	emergencySave: EmergencySaveId
	memory: MemoryId
	plugin: PluginId
	sandbox: SandboxId
	auditEvent: AuditEventId
	user: UserId
	agent: AgentId
	memoryStoreRef: MemoryStoreRef
	vaultRef: VaultRef
	knowledgeBaseRef: KnowledgeBaseRef
	project: ProjectId
	topic: TopicId
	subSession: SubSessionId
	handoff: HandoffId
	workspace: WorkspaceId
	summary: SummaryId
	deliverable: DeliverableId
}

export type EntityIdKind = keyof EntityIdByKind

const ENTITY_KINDS = new Set<EntityIdKind>([
	'run',
	'message',
	'session',
	'goal',
	'toolCall',
	'activity',
	'task',
	'plan',
	'knowledgeBase',
	'document',
	'chunk',
	'connector',
	'connectorInstance',
	'tenant',
	'credential',
	'executionContext',
	'mcpServer',
	'mcpClient',
	'mcpSession',
	'environment',
	'checkpoint',
	'lock',
	'advisory',
	'advisoryCall',
	'emergencySave',
	'memory',
	'plugin',
	'sandbox',
	'auditEvent',
	'user',
	'agent',
	'memoryStoreRef',
	'vaultRef',
	'knowledgeBaseRef',
	'project',
	'topic',
	'subSession',
	'handoff',
	'workspace',
	'summary',
	'deliverable',
])

const ID_PATTERN = entityIdPattern()

/**
 * Checks an id without throwing or rewriting it. UUIDs identify opaque
 * entities; the kind comes from the caller's field or collection.
 * This validates spelling, not existence, ownership, or access permission.
 */
export function isEntityId<K extends EntityIdKind>(
	value: unknown,
	kind: K,
): value is EntityIdByKind[K] {
	if (typeof value !== 'string') return false
	return ENTITY_KINDS.has(kind) && ID_PATTERN.test(value)
}

function parseId<K extends EntityIdKind>(
	raw: string,
	kind: K,
	typeName: string,
): EntityIdByKind[K] {
	if (!isEntityId(raw, kind)) {
		throw new Error(`Invalid ${typeName}: expected a UUID, got ${JSON.stringify(raw)}`)
	}
	return raw
}

/** @deprecated Use the `as*Id` constructor of the same type; this family throws a plain Error and is removed in the next major. */
export function parseProjectId(raw: string): ProjectId {
	return parseId(raw, 'project', 'ProjectId')
}
/** @deprecated Use the `as*Id` constructor of the same type; this family throws a plain Error and is removed in the next major. */
export function parseRunId(raw: string): RunId {
	return parseId(raw, 'run', 'RunId')
}
/** @deprecated Use the `as*Id` constructor of the same type; this family throws a plain Error and is removed in the next major. */
export function parseConnectorInstanceId(raw: string): ConnectorInstanceId {
	return parseId(raw, 'connectorInstance', 'ConnectorInstanceId')
}
/** @deprecated Use the `as*Id` constructor of the same type; this family throws a plain Error and is removed in the next major. */
export function parsePluginId(raw: string): PluginId {
	return parseId(raw, 'plugin', 'PluginId')
}
/** @deprecated Use the `as*Id` constructor of the same type; this family throws a plain Error and is removed in the next major. */
export function parseSandboxId(raw: string): SandboxId {
	return parseId(raw, 'sandbox', 'SandboxId')
}

// Brands do not validate JSON, JavaScript callers, or type assertions.
// Storage boundaries must check again before using an id as a path segment.

/** A value that cannot represent an entity id because it is not a UUID. */
export class InvalidIdError extends Error {
	constructor(
		readonly value: string,
		/** The typed field or collection that required an identity. */
		readonly expectedKind: EntityIdKind,
	) {
		super(
			`Invalid ${expectedKind} id: ${JSON.stringify(value)} must be a UUID. Prefixed IDs are not supported. Use the matching generate*Id() factory to mint an id.`,
		)
		this.name = 'InvalidIdError'
	}
}

type IdParser<T extends string> = (value: string) => T

function makeIdParser<K extends EntityIdKind>(kind: K): IdParser<EntityIdByKind[K]> {
	return (value) => {
		if (!isEntityId(value, kind)) throw new InvalidIdError(value, kind)
		return value
	}
}

export const asRunId: IdParser<RunId> = makeIdParser('run')
export const asMessageId: IdParser<MessageId> = makeIdParser('message')
export const asSessionId: IdParser<SessionId> = makeIdParser('session')
export const asGoalId: IdParser<GoalId> = makeIdParser('goal')
export const asToolCallId: IdParser<ToolCallId> = makeIdParser('toolCall')
export const asActivityId: IdParser<ActivityId> = makeIdParser('activity')
export const asTaskId: IdParser<TaskId> = makeIdParser('task')
export const asPlanId: IdParser<PlanId> = makeIdParser('plan')
export const asKnowledgeBaseId: IdParser<KnowledgeBaseId> = makeIdParser('knowledgeBase')
export const asDocumentId: IdParser<DocumentId> = makeIdParser('document')
export const asChunkId: IdParser<ChunkId> = makeIdParser('chunk')
export const asConnectorId: IdParser<ConnectorId> = makeIdParser('connector')
export const asConnectorInstanceId: IdParser<ConnectorInstanceId> =
	makeIdParser('connectorInstance')
export const asTenantId: IdParser<TenantId> = makeIdParser('tenant')
export const asCredentialId: IdParser<CredentialId> = makeIdParser('credential')
export const asExecutionContextId: IdParser<ExecutionContextId> = makeIdParser('executionContext')
export const asMCPServerId: IdParser<MCPServerId> = makeIdParser('mcpServer')
export const asMCPClientId: IdParser<MCPClientId> = makeIdParser('mcpClient')
export const asMCPSessionId: IdParser<MCPSessionId> = makeIdParser('mcpSession')
export const asEnvironmentId: IdParser<EnvironmentId> = makeIdParser('environment')
export const asCheckpointId: IdParser<CheckpointId> = makeIdParser('checkpoint')
export const asLockId: IdParser<LockId> = makeIdParser('lock')
export const asAdvisoryId: IdParser<AdvisoryId> = makeIdParser('advisory')
export const asAdvisoryCallId: IdParser<AdvisoryCallId> = makeIdParser('advisoryCall')
export const asEmergencySaveId: IdParser<EmergencySaveId> = makeIdParser('emergencySave')
export const asMemoryId: IdParser<MemoryId> = makeIdParser('memory')
export const asPluginId: IdParser<PluginId> = makeIdParser('plugin')
export const asSandboxId: IdParser<SandboxId> = makeIdParser('sandbox')
export const asAuditEventId: IdParser<AuditEventId> = makeIdParser('auditEvent')
export const asUserId: IdParser<UserId> = makeIdParser('user')
/**
 * @deprecated Agents are named by their registry keys, which have no entity-id
 * spelling contract. Use the registry key as a string. See {@link AgentId}.
 * Removal is a later major.
 */
export const asAgentId: IdParser<AgentId> = makeIdParser('agent')
export const asMemoryStoreRef: IdParser<MemoryStoreRef> = makeIdParser('memoryStoreRef')
export const asVaultRef: IdParser<VaultRef> = makeIdParser('vaultRef')
export const asKnowledgeBaseRef: IdParser<KnowledgeBaseRef> = makeIdParser('knowledgeBaseRef')
export const asProjectId: IdParser<ProjectId> = makeIdParser('project')
export const asTopicId: IdParser<TopicId> = makeIdParser('topic')
export const asSubSessionId: IdParser<SubSessionId> = makeIdParser('subSession')
export const asHandoffId: IdParser<HandoffId> = makeIdParser('handoff')
export const asWorkspaceId: IdParser<WorkspaceId> = makeIdParser('workspace')
export const asSummaryId: IdParser<SummaryId> = makeIdParser('summary')
export const asDeliverableId: IdParser<DeliverableId> = makeIdParser('deliverable')

// No asThreadId: the ambiguous thd_ container prefix remains retired.

// `ToolUseId` is a bare `string` — it comes from a provider, which chooses
// its own shape, so there is no prefix to check and a constructor here would
// be a check that cannot fail.
