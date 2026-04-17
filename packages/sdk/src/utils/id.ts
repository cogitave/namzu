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

/**
 * @deprecated Prefer {@link generateProjectId}. `ThreadId` is an alias of
 * `ProjectId` during the 0.2.x migration window; this helper emits the new
 * `prj_` prefix and will be removed in 0.3.0. See session-hierarchy.md §13.
 */
export function generateThreadId(): ThreadId {
	return generateId('prj_')
}

export function generateProjectId(): ProjectId {
	return generateId('prj_')
}

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

function parseId<T extends string>(raw: string, prefix: string, typeName: string): T {
	if (!raw.startsWith(prefix)) {
		throw new Error(`Invalid ${typeName}: expected "${prefix}" prefix, got "${raw}"`)
	}
	return raw as T
}

/**
 * @deprecated Parses either the legacy `thd_*` prefix or the new `prj_*`
 * prefix during the 0.2.x migration window. 0.3.x will only accept `prj_*`.
 * See session-hierarchy.md §13.3.1.
 */
export function parseThreadId(raw: string): ThreadId {
	if (raw.startsWith('prj_')) {
		return raw as ThreadId
	}
	if (raw.startsWith('thd_')) {
		// Read-accept legacy prefix; a proper coercion pipeline lands in Phase 7.
		return raw as unknown as ThreadId
	}
	throw new Error(`Invalid ThreadId: expected "prj_" or "thd_" prefix, got "${raw}"`)
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
