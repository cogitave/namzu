import { randomBytes } from 'node:crypto'
import type {
	ActivityId,
	AdvisoryCallId,
	AdvisoryId,
	CheckpointId,
	ChunkId,
	ConnectorId,
	ConnectorInstanceId,
	CredentialId,
	DecisionRequestId,
	DeliverableId,
	DocumentId,
	EmergencySaveId,
	EnvironmentId,
	ExecutionContextId,
	HandoffId,
	KnowledgeBaseId,
	MCPClientId,
	MCPServerId,
	MCPSessionId,
	MemoryId,
	MessageId,
	PlanId,
	PluginId,
	ProjectId,
	ResumeToken,
	RunId,
	SandboxId,
	SessionId,
	SubSessionId,
	SummaryId,
	TaskId,
	TenantId,
	ThreadId,
	ToolCallId,
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

export function generateThreadId(): ThreadId {
	return generateId('thd_')
}

export function generateRunId(): RunId {
	return generateId('run_')
}

/**
 * A short unguessable token, minted once per run, that makes the framework's own
 * XML frames unforgeable.
 *
 * The runtime wraps sub-agent results and advisory output in tags the model is
 * told to trust. Content inside those frames is written by a sub-agent, an
 * advisor LLM or an MCP server, so a payload containing a literal
 * `</task-notification>` used to be able to close the frame early and have the
 * rest of itself read as framework-authored instruction. Escaping the payload
 * stops that, but corrupts content the model has to reproduce byte-exactly (code,
 * paths). Naming the tags `<task-notification-{nonce}>` instead keeps the payload
 * verbatim and makes the boundary the thing an attacker cannot reproduce: the
 * nonce is generated per run and never appears in the model's input except on the
 * framework's own tags.
 *
 * Random, not derived from the run id — the run id reaches the model in tool
 * results and events, and a derivable nonce is a forgeable one.
 */
export function generateFrameNonce(): string {
	return randomBytes(4).toString('hex')
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

export function generateDecisionRequestId(): DecisionRequestId {
	return generateId('dreq_')
}

/**
 * Mint a resume token — the capability that lets one paused decision be answered.
 *
 * 256 bits from the same CSPRNG every other id here uses, hex-encoded, rather than the
 * 12-character base36 suffix (~62 bits) the id generator hands out. An id only has to
 * be unique; a bearer capability has to be **unguessable**, and it is the thing standing
 * between an attacker and a resumed run. The extra entropy is free.
 *
 * Possession is necessary, never sufficient — see {@link ResumeToken}.
 */
export function generateResumeToken(): ResumeToken {
	return `rt_${randomBytes(32).toString('hex')}`
}

export function generateAdvisoryId(): AdvisoryId {
	return generateId('adv_')
}

export function generateAdvisoryCallId(): AdvisoryCallId {
	return generateId('advc_')
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
