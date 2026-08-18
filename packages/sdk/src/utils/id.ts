import { randomBytes } from 'node:crypto'
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

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const ALPHABET_LEN = ALPHABET.length
const MAX_UNIFORM_BYTE = Math.floor(256 / ALPHABET_LEN) * ALPHABET_LEN

/**
 * Mints an id, with the PREFIX checked against the id's own type.
 *
 * The two type parameters are what keeps that check alive now the ids are
 * nominal (NZ-SURF-11). `T` is inferred from the caller's declared return
 * type, `P` from the literal prefix, and the constraint `T extends
 * `${P}${string}`` is what makes `generateRunId` unable to return
 * `generateId('ses_')`: a branded `RunId` is assignable to `` `run_${string}` ``
 * but not to `` `ses_${string}` ``, so the wrong prefix fails to compile.
 *
 * Without the constraint the brand would have COST a check — `unsafeId<T>`
 * accepts any string, so `T` alone would let every generator mint any
 * prefix. That is the docker `sandbox_`/`sbx_` defect, one layer up, which
 * is why this is written the awkward way rather than the short way.
 */
function generateId<T extends `${P}${string}`, P extends string = string>(
	prefix: P,
	length = 12,
): T {
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
	return unsafeId<T>(`${prefix}${suffix}`)
}

export function generateProjectId(): ProjectId {
	return generateId('prj_')
}

export function generateTopicId(): TopicId {
	return generateId('top_')
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

export function generateGoalId(): GoalId {
	return generateId('goal_')
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

function parseId<T extends `${P}${string}`, P extends string = string>(
	raw: string,
	prefix: P,
	typeName: string,
): T {
	if (!raw.startsWith(prefix)) {
		throw new Error(`Invalid ${typeName}: expected "${prefix}" prefix, got "${raw}"`)
	}
	return unsafeId<T>(raw)
}

export function parseProjectId(raw: string): ProjectId {
	return parseId(raw, 'prj_', 'ProjectId')
}
export function parseRunId(raw: string): RunId {
	return parseId(raw, 'run_', 'RunId')
}
export function parseConnectorInstanceId(raw: string): ConnectorInstanceId {
	return parseId(raw, 'ci_', 'ConnectorInstanceId')
}
export function parsePluginId(raw: string): PluginId {
	return parseId(raw, 'plg_', 'PluginId')
}
export function parseSandboxId(raw: string): SandboxId {
	return parseId(raw, 'sbx_', 'SandboxId')
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
/**
 * What a checked constructor is, named so the id type can be supplied by
 * ANNOTATION rather than as a type argument.
 *
 * That distinction is load-bearing and was got wrong once. `makeIdParser<
 * RunId>('ses_')` compiles: supplying one of two type parameters explicitly
 * makes the other fall back to its DEFAULT rather than be inferred, so `P`
 * became `string`, the constraint read `RunId extends string`, and the
 * prefix check evaporated. Caught by mutating `asRunId`'s prefix and finding
 * the build still green — a check that cannot fail. With the type on the
 * const instead, `T` comes from the contextual type and `P` is inferred from
 * the argument, so the same mutation is a compile error.
 */
type IdParser<T extends string> = (value: string) => T

function makeIdParser<T extends `${P}${string}`, P extends string = string>(
	prefix: P,
): IdParser<T> {
	return (value: string): T => {
		if (!value.startsWith(prefix)) throw new InvalidIdError(value, prefix)
		return unsafeId<T>(value)
	}
}

export const asRunId: IdParser<RunId> = makeIdParser('run_')
export const asMessageId: IdParser<MessageId> = makeIdParser('msg_')
export const asSessionId: IdParser<SessionId> = makeIdParser('ses_')
export const asGoalId: IdParser<GoalId> = makeIdParser('goal_')
export const asToolCallId: IdParser<ToolCallId> = makeIdParser('call_')
export const asActivityId: IdParser<ActivityId> = makeIdParser('act_')
export const asTaskId: IdParser<TaskId> = makeIdParser('task_')
export const asPlanId: IdParser<PlanId> = makeIdParser('plan_')
export const asKnowledgeBaseId: IdParser<KnowledgeBaseId> = makeIdParser('kb_')
export const asDocumentId: IdParser<DocumentId> = makeIdParser('doc_')
export const asChunkId: IdParser<ChunkId> = makeIdParser('chk_')
export const asConnectorId: IdParser<ConnectorId> = makeIdParser('conn_')
export const asConnectorInstanceId: IdParser<ConnectorInstanceId> = makeIdParser('ci_')
export const asTenantId: IdParser<TenantId> = makeIdParser('tnt_')
export const asCredentialId: IdParser<CredentialId> = makeIdParser('cred_')
export const asExecutionContextId: IdParser<ExecutionContextId> = makeIdParser('ectx_')
export const asMCPServerId: IdParser<MCPServerId> = makeIdParser('mcp_')
export const asMCPClientId: IdParser<MCPClientId> = makeIdParser('mcpc_')
export const asMCPSessionId: IdParser<MCPSessionId> = makeIdParser('mcps_')
export const asEnvironmentId: IdParser<EnvironmentId> = makeIdParser('env_')
export const asCheckpointId: IdParser<CheckpointId> = makeIdParser('cp_')
export const asLockId: IdParser<LockId> = makeIdParser('lock_')
export const asAdvisoryId: IdParser<AdvisoryId> = makeIdParser('adv_')
export const asAdvisoryCallId: IdParser<AdvisoryCallId> = makeIdParser('advc_')
export const asEmergencySaveId: IdParser<EmergencySaveId> = makeIdParser('esave_')
export const asMemoryId: IdParser<MemoryId> = makeIdParser('mem_')
export const asPluginId: IdParser<PluginId> = makeIdParser('plg_')
export const asSandboxId: IdParser<SandboxId> = makeIdParser('sbx_')
export const asAuditEventId: IdParser<AuditEventId> = makeIdParser('aud_')
export const asUserId: IdParser<UserId> = makeIdParser('usr_')
/**
 * @deprecated Nothing in this kernel mints an `agt_` id, so this constructor
 * throws on every agent identifier the kernel actually produces — an agent is
 * named by its registry key. See {@link AgentId}. Removal is a later major.
 */
export const asAgentId: IdParser<AgentId> = makeIdParser('agt_')
export const asMemoryStoreRef: IdParser<MemoryStoreRef> = makeIdParser('mms_')
export const asVaultRef: IdParser<VaultRef> = makeIdParser('vlt_')
export const asKnowledgeBaseRef: IdParser<KnowledgeBaseRef> = makeIdParser('kbs_')
export const asProjectId: IdParser<ProjectId> = makeIdParser('prj_')
export const asTopicId: IdParser<TopicId> = makeIdParser('top_')
export const asSubSessionId: IdParser<SubSessionId> = makeIdParser('sub_')
export const asHandoffId: IdParser<HandoffId> = makeIdParser('hof_')
export const asWorkspaceId: IdParser<WorkspaceId> = makeIdParser('wsp_')
export const asSummaryId: IdParser<SummaryId> = makeIdParser('sum_')
export const asDeliverableId: IdParser<DeliverableId> = makeIdParser('del_')

// No `asThreadId`, deliberately. `ThreadId` is an alias of `TopicId` from
// the Topic rename, so `asTopicId` already accepts every value one can hold
// — and a parser shipped `@deprecated` on the day it is written is a name
// that exists only to be removed. `declared-but-undriven`.

// `ToolUseId` is a bare `string` — it comes from a provider, which chooses
// its own shape, so there is no prefix to check and a constructor here would
// be a check that cannot fail.
