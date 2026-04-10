import { randomBytes } from 'node:crypto'
import type {
	ActivityId,
	CheckpointId,
	ChunkId,
	ConnectorId,
	ConnectorInstanceId,
	CredentialId,
	DocumentId,
	EnvironmentId,
	ExecutionContextId,
	KnowledgeBaseId,
	MCPClientId,
	MCPServerId,
	MCPSessionId,
	MessageId,
	PlanId,
	RunId,
	SessionId,
	TaskId,
	TenantId,
	ThreadId,
	ToolCallId,
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

export function generateThreadId(): ThreadId {
	return generateId('thd_')
}

export function generateRunId(): RunId {
	return generateId('run_')
}

export function generateMessageId(): MessageId {
	return generateId('msg_')
}

export function generateSessionId(): SessionId {
	return generateId('sess_')
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
	return generateId('ten_')
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

function parseId<T extends string>(raw: string, prefix: string, typeName: string): T {
	if (!raw.startsWith(prefix)) {
		throw new Error(`Invalid ${typeName}: expected "${prefix}" prefix, got "${raw}"`)
	}
	return raw as T
}

export function parseThreadId(raw: string): ThreadId {
	return parseId<ThreadId>(raw, 'thd_', 'ThreadId')
}
export function parseRunId(raw: string): RunId {
	return parseId<RunId>(raw, 'run_', 'RunId')
}
export function parseConnectorInstanceId(raw: string): ConnectorInstanceId {
	return parseId<ConnectorInstanceId>(raw, 'ci_', 'ConnectorInstanceId')
}
