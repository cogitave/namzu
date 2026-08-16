import { randomBytes } from 'node:crypto'
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

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const ALPHABET_LEN = ALPHABET.length
const MAX_UNIFORM_BYTE = Math.floor(256 / ALPHABET_LEN) * ALPHABET_LEN

function generateId<T extends string>(prefix: T, length = 12): `${T}${string}` {
	let suffix = ''
	let remaining = length
	while (remaining > 0) {
		const bytes = randomBytes(remaining + 8)
		for (const byte of bytes) {
			if (remaining <= 0) break
			if (byte < MAX_UNIFORM_BYTE) {
				suffix += ALPHABET[byte % ALPHABET_LEN]
				remaining--
			}
		}
	}
	return `${prefix}${suffix}` as `${T}${string}`
}

export function generateProjectId(): ProjectId {
	return generateId('prj_')
}

export function generateTopicId(): TopicId {
	return generateId('top_')
}

/**
 * @deprecated Use {@link generateTopicId}. Removal is NZ-TOPIC-05.
 *
 * Mints `top_` from NZ-TOPIC-04 on — an alias that kept minting `thd_`
 * would hand two different id spaces to one program depending on which
 * name the caller happened to import.
 */
export const generateThreadId = generateTopicId

export function generateRunId(): RunId {
	return generateId('run_')
}

export function generateMessageId(): MessageId {
	return generateId('msg_')
}

export function generateSessionId(): SessionId {
	return generateId('ses_')
}

export function generateToolCallId(): ToolCallId {
	return generateId('call_', 8)
}

export function generateActivityId(): ActivityId {
	return generateId('act_')
}

export function generateTaskId(): TaskId {
	return generateId('task_')
}

export function generatePlanId(): PlanId {
	return generateId('plan_')
}

export function generateKnowledgeBaseId(): KnowledgeBaseId {
	return generateId('kb_')
}

export function generateDocumentId(): DocumentId {
	return generateId('doc_')
}

export function generateChunkId(): ChunkId {
	return generateId('chk_')
}

export function generateConnectorId(): ConnectorId {
	return generateId('conn_')
}

export function generateConnectorInstanceId(): ConnectorInstanceId {
	return generateId('ci_')
}

export function generateTenantId(): TenantId {
	return generateId('tnt_')
}

export function generateCredentialId(): CredentialId {
	return generateId('cred_')
}

export function generateExecutionContextId(): ExecutionContextId {
	return generateId('ectx_')
}

export function generateMCPServerId(): MCPServerId {
	return generateId('mcp_')
}

export function generateMCPClientId(): MCPClientId {
	return generateId('mcpc_')
}

export function generateMCPSessionId(): MCPSessionId {
	return generateId('mcps_')
}

export function generateEnvironmentId(): EnvironmentId {
	return generateId('env_')
}

export function generateCheckpointId(): CheckpointId {
	return generateId('cp_')
}

export function generateAdvisoryId(): AdvisoryId {
	return generateId('adv_')
}

export function generateAdvisoryCallId(): AdvisoryCallId {
	return generateId('advc_')
}

export function generateAuditEventId(): AuditEventId {
	return generateId('aud_')
}

export function generateEmergencySaveId(): EmergencySaveId {
	return generateId('esave_')
}

export function generateMemoryId(): MemoryId {
	return generateId('mem_')
}

export function generatePluginId(): PluginId {
	return generateId('plg_')
}

export function generateSandboxId(): SandboxId {
	return generateId('sbx_')
}

export function generateWorkspaceId(): WorkspaceId {
	return generateId('wsp_')
}

export function generateSubSessionId(): SubSessionId {
	return generateId('sub_')
}

export function generateSummaryId(): SummaryId {
	return generateId('sum_')
}

export function generateHandoffId(): HandoffId {
	return generateId('hof_')
}

export function generateDeliverableId(): DeliverableId {
	return generateId('del_')
}

function parseId<T extends string>(raw: string, prefix: string, typeName: string): T {
	if (!raw.startsWith(prefix)) {
		throw new Error(`Invalid ${typeName}: expected "${prefix}" prefix, got "${raw}"`)
	}
	return raw as T
}

export function parseProjectId(raw: string): ProjectId {
	return parseId<ProjectId>(raw, 'prj_', 'ProjectId')
}
export function parseRunId(raw: string): RunId {
	return parseId<RunId>(raw, 'run_', 'RunId')
}
export function parseConnectorInstanceId(raw: string): ConnectorInstanceId {
	return parseId<ConnectorInstanceId>(raw, 'ci_', 'ConnectorInstanceId')
}
export function parsePluginId(raw: string): PluginId {
	return parseId<PluginId>(raw, 'plg_', 'PluginId')
}
export function parseSandboxId(raw: string): SandboxId {
	return parseId<SandboxId>(raw, 'sbx_', 'SandboxId')
}

// ─── validating constructors ─────────────────────────────────────────────
//
// There is no runtime prefix check anywhere in this tree. The 700-odd
// `as RunId` casts in it assert without verifying, so a `ses_` value cast to
// `RunId` reaches a store key unremarked and the first sign of it is a
// lookup that finds nothing.
//
// These are the check. One per id type rather than a single generic
// `asId(prefix, value)`, and the repetition is the point: a generic loses
// the return type, so the call site stops type-checking and the whole
// exercise buys nothing. The implementations are one function.

/** A string that does not carry the prefix the id type requires. */
export class InvalidIdError extends Error {
	constructor(
		readonly value: string,
		readonly expectedPrefix: string,
	) {
		super(
			`Not a valid id: ${JSON.stringify(value)} does not start with ${JSON.stringify(expectedPrefix)}. Ids are minted by the matching generate*Id() factory; a literal from a log or a URL has to be checked before it is used as one.`,
		)
		this.name = 'InvalidIdError'
	}
}

/**
 * Builds one prefix check.
 *
 * Throws rather than returning `undefined`, per `refuse-do-not-degrade`: a
 * caller holding a malformed id has no correct fallback available, and the
 * value is on its way to becoming a store key. Returning the input
 * unchanged on the happy path is also load-bearing — a constructor that
 * allocated a copy would silently break `===` on ids used as map keys.
 *
 * The trailing underscore in every prefix is what makes them unambiguous:
 * `mcpc_x` does not start with `mcp_`, and `advc_x` does not start with
 * `adv_`, so no id type can swallow another's values.
 */
function makeIdParser<T extends string>(prefix: string): (value: string) => T {
	return (value: string): T => {
		if (!value.startsWith(prefix)) throw new InvalidIdError(value, prefix)
		return value as T
	}
}

export const asRunId = makeIdParser<RunId>('run_')
export const asMessageId = makeIdParser<MessageId>('msg_')
export const asSessionId = makeIdParser<SessionId>('ses_')
export const asToolCallId = makeIdParser<ToolCallId>('call_')
export const asActivityId = makeIdParser<ActivityId>('act_')
export const asTaskId = makeIdParser<TaskId>('task_')
export const asPlanId = makeIdParser<PlanId>('plan_')
export const asKnowledgeBaseId = makeIdParser<KnowledgeBaseId>('kb_')
export const asDocumentId = makeIdParser<DocumentId>('doc_')
export const asChunkId = makeIdParser<ChunkId>('chk_')
export const asConnectorId = makeIdParser<ConnectorId>('conn_')
export const asConnectorInstanceId = makeIdParser<ConnectorInstanceId>('ci_')
export const asTenantId = makeIdParser<TenantId>('tnt_')
export const asCredentialId = makeIdParser<CredentialId>('cred_')
export const asExecutionContextId = makeIdParser<ExecutionContextId>('ectx_')
export const asMCPServerId = makeIdParser<MCPServerId>('mcp_')
export const asMCPClientId = makeIdParser<MCPClientId>('mcpc_')
export const asMCPSessionId = makeIdParser<MCPSessionId>('mcps_')
export const asEnvironmentId = makeIdParser<EnvironmentId>('env_')
export const asCheckpointId = makeIdParser<CheckpointId>('cp_')
export const asLockId = makeIdParser<LockId>('lock_')
export const asAdvisoryId = makeIdParser<AdvisoryId>('adv_')
export const asAdvisoryCallId = makeIdParser<AdvisoryCallId>('advc_')
export const asEmergencySaveId = makeIdParser<EmergencySaveId>('esave_')
export const asMemoryId = makeIdParser<MemoryId>('mem_')
export const asPluginId = makeIdParser<PluginId>('plg_')
export const asSandboxId = makeIdParser<SandboxId>('sbx_')
export const asAuditEventId = makeIdParser<AuditEventId>('aud_')
export const asUserId = makeIdParser<UserId>('usr_')
export const asAgentId = makeIdParser<AgentId>('agt_')
export const asMemoryStoreRef = makeIdParser<MemoryStoreRef>('mms_')
export const asVaultRef = makeIdParser<VaultRef>('vlt_')
export const asKnowledgeBaseRef = makeIdParser<KnowledgeBaseRef>('kbs_')
export const asProjectId = makeIdParser<ProjectId>('prj_')
export const asTopicId = makeIdParser<TopicId>('top_')
export const asSubSessionId = makeIdParser<SubSessionId>('sub_')
export const asHandoffId = makeIdParser<HandoffId>('hof_')
export const asWorkspaceId = makeIdParser<WorkspaceId>('wsp_')
export const asSummaryId = makeIdParser<SummaryId>('sum_')
export const asDeliverableId = makeIdParser<DeliverableId>('del_')

// No `asThreadId`, deliberately. `ThreadId` is an alias of `TopicId` from
// the Topic rename, so `asTopicId` already accepts every value one can hold
// — and a parser shipped `@deprecated` on the day it is written is a name
// that exists only to be removed. `declared-but-undriven`.

// `ToolUseId` is a bare `string` — it comes from a provider, which chooses
// its own shape, so there is no prefix to check and a constructor here would
// be a check that cannot fail.
