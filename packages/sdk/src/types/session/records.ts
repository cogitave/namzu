import { z } from 'zod'
import { type EntityIdKind, isEntityId } from '../../utils/id.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../hitl/index.js'
import type {
	CheckpointId,
	MessageId,
	ProjectId,
	RecordId,
	SessionId,
	TenantId,
	TopicId,
	TurnId,
} from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ActorRef } from './actor.js'
import { CostInfoSchema, TokenUsageSchema, TurnBudgetBindingSchema } from './checkpoint.js'
import {
	EPHEMERAL_EVENT_TYPES,
	type PersistedSessionEventType,
	type SessionEvent,
	type SessionEventType,
} from './events.js'

/**
 * The session log: one append-only, hash-chained JSONL file per session, the
 * source of truth for everything the session did. Every line is one record.
 * `docs/sdk/session-log.md` is the reader's description of this module.
 */

/** Schema version stamped on every record as `v`. A reader refuses any other value. */
export const SESSION_RECORD_SCHEMA_VERSION = 1 as const
export type SessionRecordSchemaVersion = typeof SESSION_RECORD_SCHEMA_VERSION

/** Largest record a log accepts, newline included. Larger content spills to `tool-results/`. */
export const SESSION_RECORD_MAX_BYTES = 4 * 1024 * 1024

// ─── primitives ───────────────────────────────────────────────────────────

const count = z.number().int().nonnegative().safe()
const positive = count.positive()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
/** ISO-8601 in UTC with a `Z` suffix. */
const isoUtc = z.string().datetime({ offset: false })
const text = z.string()

/** Annotated with the id's own alias, so declarations name `SessionId` rather than expanding its brand. */
function idSchema<T extends string>(kind: EntityIdKind): z.ZodType<T, z.ZodTypeDef, unknown> {
	return z.custom<T>((value) => isEntityId(value, kind), {
		message: `expected a ${kind} id (UUID)`,
	})
}

const sessionId = idSchema<SessionId>('session')
const turnId = idSchema<TurnId>('turn')
const messageId = idSchema<MessageId>('message')
const checkpointId = idSchema<CheckpointId>('checkpoint')
const recordId = idSchema<RecordId>('record')
const projectId = idSchema<ProjectId>('project')
const tenantId = idSchema<TenantId>('tenant')
const topicId = idSchema<TopicId>('topic')

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

/**
 * A message body. The record keeps the SDK `Message` shape verbatim; the
 * schema checks the discriminant and leaves the content to the message types.
 */
const messageBody = z.custom<Message>(
	(value) => isPlainObject(value) && MESSAGE_ROLES.has(value.role as string),
	{ message: 'expected a message with a system, user, assistant or tool role' },
)

// ─── envelope ─────────────────────────────────────────────────────────────

/**
 * Where a record sits in its log: its seq, its byte offset and length (the
 * terminating newline included), and the SHA-256 of exactly those bytes.
 */
export const RecordPointerSchema = z
	.object({
		seq: positive,
		offset: count,
		length: positive.max(SESSION_RECORD_MAX_BYTES),
		sha256,
	})
	.strict()
export type RecordPointer = z.infer<typeof RecordPointerSchema>

const envelopeShape = {
	v: z.literal(SESSION_RECORD_SCHEMA_VERSION),
	id: recordId,
	sessionId,
	/**
	 * The turn the record belongs to; absent on a record outside any turn. A
	 * record never names a closed turn: the `child_session_*` records carry
	 * their spawning turn only while it is open, and omit it afterwards.
	 */
	turnId: turnId.optional(),
	/** 1-based and contiguous. */
	seq: positive,
	ts: isoUtc,
	/** The previous record; `null` only at seq 1. */
	prev: RecordPointerSchema.nullable(),
	/** Skip link to the previous record that carries text, for evidence search. */
	prevText: RecordPointerSchema.nullable().optional(),
	/** The fencing token of the lease the writer held. */
	gen: count,
}

/** The fields every record carries. */
export interface RecordEnvelope {
	readonly v: SessionRecordSchemaVersion
	readonly id: RecordId
	readonly sessionId: SessionId
	readonly turnId?: TurnId
	readonly seq: number
	readonly ts: string
	readonly prev: RecordPointer | null
	readonly prevText?: RecordPointer | null
	readonly gen: number
}

// ─── shared payload shapes ────────────────────────────────────────────────

export const OriginSchema = z
	.object({
		protocol: z.enum(['cli', 'sdk', 'ag-ui', 'a2a', 'acp', 'http', 'desktop', 'resident']),
		externalSessionId: text.optional(),
		externalTurnId: text.optional(),
		kind: z.enum(['prompt', 'goal-round', 'resident-step', 'verification']).optional(),
		goalId: text.optional(),
		round: count.optional(),
	})
	.strict()

export const ExternalRefSchema = z
	.object({
		protocol: text.min(1),
		kind: z.enum(['session', 'thread', 'context']),
		externalId: text.min(1),
	})
	.strict()

const turnExecutionStatus = z.enum([
	'idle',
	'pending',
	'running',
	'completed',
	'failed',
	'cancelled',
])

const turnConfigSnapshot = z
	.object({
		model: text,
		tokenBudget: z.number().nonnegative(),
		timeoutMs: z.number().nonnegative(),
		streamIdleTimeoutMs: z.number().nonnegative().optional(),
		maxRequestRichContentBytes: z.number().nonnegative().optional(),
		maxIterations: count.optional(),
		temperature: z.number().optional(),
		maxResponseTokens: count.optional(),
		costLimitUsd: z.number().nonnegative().optional(),
	})
	.strict()

const tokenBudgetSummary = z
	.object({
		limit: z.number().nonnegative(),
		ownTokens: count,
		treeTokens: count,
		reservedTokens: count,
		remainingTokens: z.number().nullable(),
		inFlightRequests: count,
		unsettledChildren: count,
		poisoned: z.boolean(),
		unresolvedRequests: count.optional(),
	})
	.strict()

const platformError = z
	.object({
		code: text,
		message: text,
		details: z.record(z.unknown()).optional(),
		retryable: z.boolean(),
	})
	.strict()

/** The provider's own classification; its fields are owned by `types/provider/error.ts`. */
const providerError = z
	.object({
		kind: z.enum(['throttle', 'network', 'auth', 'context_overflow', 'bad_request', 'server']),
		providerId: text,
	})
	.passthrough()

const explanation = z.object({ id: text, message: text, hint: text }).strict()

const stopReason = z.enum([
	'end_turn',
	'token_budget',
	'cost_limit',
	'cost_unmeasurable',
	'timeout',
	'max_iterations',
	'cancelled',
	'plan_rejected',
	'stop_condition',
	'step_refused',
	'structured_output_failed',
	'answer_rejected',
	'input_guardrail',
	'output_guardrail',
	'paused',
	'error',
])

const cancelCause = z.enum(['user', 'parent', 'budget', 'hook'])

const resultSource = z.enum([
	'model',
	'guardrail_blocked',
	'guardrail_rewritten',
	'review',
	'outstanding_work',
	'structured_output',
])

export const TurnSettlementSchema = z
	.object({
		status: turnExecutionStatus,
		iterations: count,
		usage: TokenUsageSchema,
		cost: CostInfoSchema,
		durationMs: count,
		resultMessageId: messageId.optional(),
		resultSource,
		structuredOutput: z.unknown().optional(),
		servingProvider: text.optional(),
		abandonedTaskIds: z.array(text),
		abandonedJobIds: z.array(text),
	})
	.strict()

/** A body too large for one record, written (and fsynced) to `tool-results/` before the record. */
const spill = z
	.object({
		path: text.min(1),
		manifest: text.min(1),
		bytes: count,
		sha256,
	})
	.strict()

const subSessionKind = z.enum(['agent_spawn', 'user_handoff', 'intervention'])

const actorRef = z.custom<ActorRef>(
	(value) =>
		isPlainObject(value) &&
		(value.kind === 'user' || value.kind === 'agent' || value.kind === 'system'),
	{ message: 'expected an actor reference' },
)

/** The request the turn parked on, minus the turn identity the envelope already carries. */
export type SessionDecisionRequest = HITLDecisionRequest extends infer R
	? R extends HITLDecisionRequest
		? Omit<R, 'runId'>
		: never
	: never

const HITL_REQUEST_TYPES = new Set([
	'plan_approval',
	'tool_review',
	'iteration_checkpoint',
	'user_question',
])
const decisionRequest = z.custom<SessionDecisionRequest>(
	(value) =>
		isPlainObject(value) &&
		HITL_REQUEST_TYPES.has(value.type as string) &&
		isEntityId(value.checkpointId, 'checkpoint') &&
		!('runId' in value),
	{ message: 'expected a decision request' },
)
const decision = z.custom<HITLResumeDecision>(
	(value) => isPlainObject(value) && typeof value.action === 'string',
	{ message: 'expected a decision' },
)

// ─── record schemas ───────────────────────────────────────────────────────

function recordSchema<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
	return z.object({ ...envelopeShape, type: z.literal(type), ...shape }).strict()
}

function inTurn<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
	return z.object({ ...envelopeShape, turnId, type: z.literal(type), ...shape }).strict()
}

// Session

export const SessionStartedRecordSchema = recordSchema('session_started', {
	projectId,
	tenantId: tenantId.optional(),
	topicId: topicId.optional(),
	cwd: text.min(1),
	agent: z.object({ id: text, name: text, type: text.optional() }).strict(),
	parent: z
		.object({
			sessionId,
			turnId,
			toolCallId: text.min(1),
			rootSessionId: sessionId,
			depth: positive,
			kind: subSessionKind,
		})
		.strict()
		.optional(),
	forkedFrom: z.object({ sessionId, turnId, checkpointId }).strict().optional(),
	origin: OriginSchema.optional(),
})

export const SessionUpdatedRecordSchema = recordSchema('session_updated', {
	title: text.optional(),
	titleSource: z.enum(['derived', 'named']).optional(),
	archived: z.boolean().optional(),
	approvalPolicy: text.optional(),
	externalRefs: z
		.object({
			add: z.array(ExternalRefSchema).optional(),
			remove: z.array(ExternalRefSchema).optional(),
		})
		.strict()
		.optional(),
})

// Turn lifecycle (also live events)

export const TurnStartedRecordSchema = inTurn('turn_started', {
	userMessageId: messageId,
	systemPrompt: text.optional(),
	config: turnConfigSnapshot,
	origin: OriginSchema.optional(),
	budget: TurnBudgetBindingSchema.optional(),
})

export const TurnPausedRecordSchema = inTurn('turn_paused', {
	reason: text,
	checkpointId,
	failure: platformError.optional(),
	providerError: providerError.optional(),
	explanation: explanation.optional(),
	budget: tokenBudgetSummary.optional(),
})

export const TurnResumingRecordSchema = inTurn('turn_resuming', {
	fromCheckpointId: checkpointId,
	resolvedDecisionId: text.optional(),
})

export const TurnCompletedRecordSchema = inTurn('turn_completed', {
	result: text,
	stopReason: stopReason.optional(),
	cancelCause: cancelCause.optional(),
	budget: tokenBudgetSummary.optional(),
	settlement: TurnSettlementSchema,
})

export const TurnFailedRecordSchema = inTurn('turn_failed', {
	error: text,
	failure: platformError.optional(),
	providerError: providerError.optional(),
	explanation: explanation.optional(),
	budget: tokenBudgetSummary.optional(),
	settlement: TurnSettlementSchema,
})

// Messages (record-only)

export const MessageRecordSchema = inTurn('message', {
	messageId,
	role: z.enum(['user', 'assistant', 'tool', 'system']),
	kind: z.enum(['prompt', 'steering', 'auto-continuation', 'context']).optional(),
	content: messageBody,
	spill: spill.optional(),
})

export const MessageReplacedRecordSchema = recordSchema('message_replaced', {
	targetMessageId: messageId,
	content: messageBody,
	reason: z.enum([
		'pin-slot',
		'guardrail_blocked',
		'guardrail_rewritten',
		'review',
		'outstanding_work',
		'structured_output',
		'history-repair',
	]),
})

// Checkpoints and human decisions (record-only)

export const CheckpointWrittenRecordSchema = inTurn('checkpoint_written', {
	checkpointId,
	iteration: count,
	throughSeq: positive,
	throughSha256: sha256,
	/** Relative to the session directory: `checkpoints/<id>.json`. */
	path: text.min(1),
	docSha256: sha256,
})

export const CheckpointPrunedRecordSchema = recordSchema('checkpoint_pruned', {
	checkpointIds: z.array(checkpointId).min(1),
})

export const DecisionRequestedRecordSchema = inTurn('decision_requested', {
	decisionId: text.min(1),
	checkpointId,
	request: decisionRequest,
	deadlineAt: isoUtc.optional(),
})

export const DecisionResolvedRecordSchema = inTurn('decision_resolved', {
	decisionId: text.min(1),
	decision,
	resolvedBy: actorRef,
})

export const DecisionExpiredRecordSchema = inTurn('decision_expired', {
	decisionId: text.min(1),
})

// Compaction (record-only; the fold reads this, not the live compaction events)

export const CompactionRecordSchema = recordSchema('compaction', {
	compactionId: text.min(1),
	strategy: text.min(1),
	trigger: z.enum(['auto', 'manual']),
	replacesSeqRange: z.tuple([positive, positive]),
	summary: z.union([z.array(messageBody), spill]),
	keptMessageIds: z.array(messageId),
	pinned: z.array(messageId).optional(),
	tokensBefore: count,
	tokensAfter: count,
})

// Children (the live child_session_* events, plus one record-only type)
//
// A child can outlive the parent turn that spawned it (`Turn.abandonedTaskIds`
// names such workers). So only the spawn is bound to a turn. The messaged,
// idled and ended records carry the spawning turn's id while that turn is
// open and omit it once the turn has closed, whether or not a later turn is
// active: the child belongs to the turn its `child_session_spawned` names, and
// a reader attributes the record through `childSessionId`.

export const ChildSessionSpawnedRecordSchema = inTurn('child_session_spawned', {
	childSessionId: sessionId,
	toolCallId: text.min(1),
	kind: subSessionKind,
	description: text,
	path: text.min(1),
	batch: z
		.object({ batchId: text.min(1), name: text, phase: text.optional() })
		.strict()
		.optional(),
	budgetAccountId: text.optional(),
})

export const ChildSessionMessagedRecordSchema = recordSchema('child_session_messaged', {
	childSessionId: sessionId,
	messageId,
})

export const ChildSessionIdledRecordSchema = recordSchema('child_session_idled', {
	childSessionId: sessionId,
})

export const ChildSessionEndedRecordSchema = recordSchema('child_session_ended', {
	childSessionId: sessionId,
	status: turnExecutionStatus,
	stopReason: stopReason.optional(),
	resultMessageId: messageId.optional(),
	usage: TokenUsageSchema,
	cost: CostInfoSchema,
})

// Other record-only types

/**
 * One audit-trail entry. It holds everything `AuditEvent` (`types/run/audit.ts`)
 * records today: `who` becomes `actor` plus `persona`, `what` is flattened into
 * `action`, `tool` and `resource`, and the envelope's `seq`, `ts` and `turnId`
 * replace the trail's own sequence, timestamp and run id.
 */
export const AuditRecordSchema = recordSchema('audit', {
	auditId: text.min(1),
	actor: actorRef,
	/** The label a host assigned the agent, when one was configured. */
	persona: text.min(1).optional(),
	action: text.min(1),
	/** The tool, for a tool-scoped action. */
	tool: text.min(1).optional(),
	/** What the action targeted when that is narrower than the tool, for example a guardrail's name. */
	resource: text.min(1).optional(),
	outcome: z.enum(['success', 'failure', 'refused']),
	cost: CostInfoSchema.optional(),
	/** Present on `refused` and `failure`. */
	reason: text.optional(),
	/** The active span when the entry was recorded; both or neither. */
	traceId: text.min(1).optional(),
	spanId: text.min(1).optional(),
})

export const BudgetBoundRecordSchema = inTurn('budget_bound', {
	rootSessionId: sessionId,
	rootTurnId: turnId,
	accountId: text.min(1),
})

export const LogRepairedRecordSchema = recordSchema('log_repaired', {
	truncatedBytes: positive,
	lastGoodSeq: positive,
})

/**
 * Event types whose payload the schema checks field by field. The other
 * persisted event types are checked for their envelope and discriminant, and
 * their payload is the `SessionEvent` member of the same `type` minus
 * `sessionId`, `turnId` and `lineage`.
 */
const SPECIFIED_EVENT_SCHEMAS = {
	turn_started: TurnStartedRecordSchema,
	turn_paused: TurnPausedRecordSchema,
	turn_resuming: TurnResumingRecordSchema,
	turn_completed: TurnCompletedRecordSchema,
	turn_failed: TurnFailedRecordSchema,
	child_session_spawned: ChildSessionSpawnedRecordSchema,
	child_session_messaged: ChildSessionMessagedRecordSchema,
	child_session_idled: ChildSessionIdledRecordSchema,
} as const

const RECORD_ONLY_SCHEMAS = {
	session_started: SessionStartedRecordSchema,
	session_updated: SessionUpdatedRecordSchema,
	message: MessageRecordSchema,
	message_replaced: MessageReplacedRecordSchema,
	checkpoint_written: CheckpointWrittenRecordSchema,
	checkpoint_pruned: CheckpointPrunedRecordSchema,
	decision_requested: DecisionRequestedRecordSchema,
	decision_resolved: DecisionResolvedRecordSchema,
	decision_expired: DecisionExpiredRecordSchema,
	compaction: CompactionRecordSchema,
	child_session_ended: ChildSessionEndedRecordSchema,
	audit: AuditRecordSchema,
	budget_bound: BudgetBoundRecordSchema,
	log_repaired: LogRepairedRecordSchema,
} as const

export type SessionRecordOnlyType = keyof typeof RECORD_ONLY_SCHEMAS

/**
 * Every live event type, each exactly once. Typed as a record over
 * `SessionEventType`, so adding or removing an event literal without updating
 * this table is a compile error.
 */
const SESSION_EVENT_TYPE_TABLE: Record<SessionEventType, true> = {
	tool_calls_admitted: true,
	turn_started: true,
	iteration_started: true,
	approval_policy_changed: true,
	request_envelope: true,
	iteration_completed: true,
	compaction_shed: true,
	compaction_completed: true,
	compaction_tool_results_cleared: true,
	compaction_failed: true,
	tool_executing: true,
	tool_progress: true,
	hosted_tool: true,
	provider_retry: true,
	provider_fallback: true,
	tool_completed: true,
	user_question_asked: true,
	user_question_answered: true,
	tool_review_requested: true,
	tool_review_completed: true,
	checkpoint_created: true,
	turn_paused: true,
	turn_resuming: true,
	guardrail_triggered: true,
	background_job_exited: true,
	memory_consolidated: true,
	turn_completed: true,
	turn_failed: true,
	capability_warning: true,
	message_history_repaired: true,
	token_usage_updated: true,
	activity_created: true,
	activity_updated: true,
	plan_ready: true,
	plan_approved: true,
	plan_rejected: true,
	plan_step_updated: true,
	plan_completed: true,
	plan_failed: true,
	agent_pending: true,
	agent_completed: true,
	agent_failed: true,
	agent_canceled: true,
	task_created: true,
	task_updated: true,
	plugin_hook_executing: true,
	plugin_hook_completed: true,
	sandbox_created: true,
	sandbox_exec: true,
	sandbox_destroyed: true,
	message_started: true,
	reasoning_started: true,
	reasoning_delta: true,
	reasoning_completed: true,
	text_delta: true,
	message_completed: true,
	tool_input_started: true,
	tool_input_delta: true,
	tool_input_completed: true,
	child_session_spawned: true,
	child_session_messaged: true,
	child_session_idled: true,
}

/** All 62 live event type literals. */
export const SESSION_EVENT_TYPES: readonly SessionEventType[] = Object.freeze(
	Object.keys(SESSION_EVENT_TYPE_TABLE) as SessionEventType[],
)

/** The 58 event types a session log records. */
export const PERSISTED_SESSION_EVENT_TYPES: readonly PersistedSessionEventType[] = Object.freeze(
	SESSION_EVENT_TYPES.filter(
		(type) => !EPHEMERAL_EVENT_TYPES.has(type),
	) as PersistedSessionEventType[],
)

/** Every `type` a session log may hold: the persisted event types and the record-only types. */
export const SESSION_RECORD_TYPES: readonly SessionRecordType[] = Object.freeze([
	...PERSISTED_SESSION_EVENT_TYPES,
	...(Object.keys(RECORD_ONLY_SCHEMAS) as SessionRecordOnlyType[]),
])

const OTHER_PERSISTED_TYPES = PERSISTED_SESSION_EVENT_TYPES.filter(
	(type) => !(type in SPECIFIED_EVENT_SCHEMAS),
) as [PersistedSessionEventType, ...PersistedSessionEventType[]]

/** Envelope-and-discriminant check for the persisted event types the table above does not specify. */
const OtherEventRecordSchema = z
	.object({ ...envelopeShape, type: z.enum(OTHER_PERSISTED_TYPES) })
	.passthrough()

/** Live-only fields a record never carries: the envelope or `session_started.parent` holds them. */
const LIVE_ONLY_KEYS = ['lineage', 'schemaVersion', 'generation', 'runId'] as const

/**
 * The persisted event types without a field-by-field schema that happen only
 * inside a turn. With the `inTurn` schemas above they are exactly the events
 * whose live type requires `turnId`; a type test holds the two lists together.
 */
const TURN_BOUND_OTHER_TYPE_LIST = [
	'tool_calls_admitted',
	'iteration_started',
	'request_envelope',
	'iteration_completed',
	'tool_executing',
	'hosted_tool',
	'provider_retry',
	'provider_fallback',
	'tool_completed',
	'user_question_asked',
	'user_question_answered',
	'tool_review_requested',
	'tool_review_completed',
	'checkpoint_created',
	'guardrail_triggered',
	'message_history_repaired',
	'token_usage_updated',
	'activity_created',
	'activity_updated',
	'plan_ready',
	'plan_approved',
	'plan_rejected',
	'plan_step_updated',
	'plan_completed',
	'plan_failed',
	'agent_pending',
	'agent_completed',
	'agent_failed',
	'agent_canceled',
	'message_started',
	'reasoning_started',
	'reasoning_completed',
	'message_completed',
	'tool_input_started',
	'tool_input_completed',
] as const satisfies readonly PersistedSessionEventType[]

const TURN_BOUND_OTHER_TYPES: ReadonlySet<string> = new Set(TURN_BOUND_OTHER_TYPE_LIST)

/** The persisted event types whose record always carries `turnId`. */
export type TurnBoundSessionEventType =
	| (typeof TURN_BOUND_OTHER_TYPE_LIST)[number]
	| 'turn_started'
	| 'turn_paused'
	| 'turn_resuming'
	| 'turn_completed'
	| 'turn_failed'
	| 'child_session_spawned'

const RECORD_OPTIONS = [
	...Object.values(SPECIFIED_EVENT_SCHEMAS),
	...Object.values(RECORD_ONLY_SCHEMAS),
	OtherEventRecordSchema,
] as unknown as [
	z.ZodDiscriminatedUnionOption<'type'>,
	z.ZodDiscriminatedUnionOption<'type'>,
	...z.ZodDiscriminatedUnionOption<'type'>[],
]

/** Validates one session record: envelope, discriminant, and every specified payload. */
export const SessionRecordSchema = z
	.discriminatedUnion('type', RECORD_OPTIONS)
	.superRefine((record, context) => {
		const r = record as Record<string, unknown> & { type: string; seq: number }
		if ((r.seq === 1) !== (r.prev === null)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['prev'],
				message: 'prev is null at seq 1 and only there',
			})
		}
		if (r.type === 'session_started' && r.turnId !== undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['turnId'],
				message: 'session_started is outside any turn',
			})
		}
		if ((r.seq === 1) !== (r.type === 'session_started')) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['type'],
				message: 'session_started is the first record of a session log, and only the first',
			})
		}
		if (TURN_BOUND_OTHER_TYPES.has(r.type) && r.turnId === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['turnId'],
				message: `${r.type} happens only inside a turn and must carry turnId`,
			})
		}
		if (r.type === 'audit' && (r.traceId === undefined) !== (r.spanId === undefined)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: [r.traceId === undefined ? 'traceId' : 'spanId'],
				message: 'an audit record carries traceId and spanId together, or neither',
			})
		}
		for (const key of LIVE_ONLY_KEYS) {
			if (Object.hasOwn(r, key)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [key],
					message: `A record does not carry ${key}; the envelope or session_started.parent holds it.`,
				})
			}
		}
	})

/** Parse one record, or throw the zod error naming every field that failed. */
export function parseSessionRecord(value: unknown): SessionRecord {
	return SessionRecordSchema.parse(value) as SessionRecord
}

// ─── TypeScript view ──────────────────────────────────────────────────────

type EventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>

/**
 * A persisted live event as a record: the event minus its live-only fields,
 * plus the envelope. A turn-bound type carries a non-optional `turnId`, as
 * `SessionRecordSchema` guarantees.
 */
export type SessionEventRecord<T extends PersistedSessionEventType = PersistedSessionEventType> =
	T extends PersistedSessionEventType
		? Omit<EventOf<T>, 'sessionId' | 'turnId' | 'lineage' | 'v' | 'seq' | 'generation'> &
				RecordEnvelope &
				(T extends TurnBoundSessionEventType ? { readonly turnId: TurnId } : unknown)
		: never

export type SessionStartedRecord = z.infer<typeof SessionStartedRecordSchema>
export type SessionUpdatedRecord = z.infer<typeof SessionUpdatedRecordSchema>
export type MessageRecord = z.infer<typeof MessageRecordSchema>
export type MessageReplacedRecord = z.infer<typeof MessageReplacedRecordSchema>
export type CheckpointWrittenRecord = z.infer<typeof CheckpointWrittenRecordSchema>
export type CheckpointPrunedRecord = z.infer<typeof CheckpointPrunedRecordSchema>
export type DecisionRequestedRecord = z.infer<typeof DecisionRequestedRecordSchema>
export type DecisionResolvedRecord = z.infer<typeof DecisionResolvedRecordSchema>
export type DecisionExpiredRecord = z.infer<typeof DecisionExpiredRecordSchema>
export type CompactionRecord = z.infer<typeof CompactionRecordSchema>
export type ChildSessionEndedRecord = z.infer<typeof ChildSessionEndedRecordSchema>
export type AuditRecord = z.infer<typeof AuditRecordSchema>
export type BudgetBoundRecord = z.infer<typeof BudgetBoundRecordSchema>
export type LogRepairedRecord = z.infer<typeof LogRepairedRecordSchema>

export type SessionRecordOnly =
	| SessionStartedRecord
	| SessionUpdatedRecord
	| MessageRecord
	| MessageReplacedRecord
	| CheckpointWrittenRecord
	| CheckpointPrunedRecord
	| DecisionRequestedRecord
	| DecisionResolvedRecord
	| DecisionExpiredRecord
	| CompactionRecord
	| ChildSessionEndedRecord
	| AuditRecord
	| BudgetBoundRecord
	| LogRepairedRecord

/** One line of a session log. */
export type SessionRecord = SessionEventRecord | SessionRecordOnly

export type SessionRecordType = SessionRecord['type']

// ─── documents beside the log ─────────────────────────────────────────────

/** `projects/<slug>/project.json`: the project id is minted once, here. */
export const ProjectDocumentSchema = z
	.object({
		v: z.literal(1),
		kind: z.literal('project'),
		projectId,
		cwd: text.min(1),
		slug: z.string().regex(/^[A-Za-z0-9-]+$/),
		createdAt: isoUtc,
	})
	.strict()
export type ProjectDocument = z.infer<typeof ProjectDocumentSchema>

/**
 * `<parent>/subagents/<child-id>.meta.json`: a convenience copy of a child
 * session's identity and status. The child's log wins on any disagreement.
 */
export const ChildSessionMetaSchema = z
	.object({
		v: z.literal(1),
		kind: z.literal('child-session'),
		sessionId,
		parentSessionId: sessionId,
		parentTurnId: turnId,
		rootSessionId: sessionId,
		depth: positive,
		toolCallId: text.min(1),
		agentType: text,
		description: text,
		status: turnExecutionStatus,
		createdAt: isoUtc,
		endedAt: isoUtc.optional(),
	})
	.strict()
export type ChildSessionMeta = z.infer<typeof ChildSessionMetaSchema>

/** `<session-id>/lease.json`: who may append, under which fence, until when. */
export const SessionLeaseDocumentSchema = z
	.object({
		v: z.literal(1),
		kind: z.literal('lease'),
		holder: text.min(1),
		fence: count,
		expiresAt: isoUtc,
	})
	.strict()
export type SessionLeaseDocument = z.infer<typeof SessionLeaseDocumentSchema>
