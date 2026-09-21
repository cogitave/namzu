import type { TokenBudgetSummary } from '../../run/token-budget.js'
import type { CostInfo, TokenUsage } from '../common/index.js'
import type {
	CheckpointId,
	MessageId,
	ProjectId,
	SessionId,
	TenantId,
	TurnId,
} from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ProviderErrorInfo } from '../provider/index.js'
// Unchanged names that still live in the run type directory until the cutover
// moves them here: the configuration a turn runs with, the per-step ledger
// and the stop reasons.
import type { AgentRunConfig } from '../run/config.js'
import type { StepResult } from '../run/step.js'
import type { StopReason } from '../run/stop-reason.js'

export type { TurnId }

/**
 * Where a turn is in its lifecycle. Six members, unchanged from the type it
 * replaces. `Turn.status` and `TurnSettlement.status` use it.
 */
export type TurnExecutionStatus =
	| 'idle'
	| 'pending'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'

/**
 * The domain status a session log's fold derives for a turn.
 *
 *  - `queued` — the turn exists and has not started.
 *  - `running` — the iteration loop is in flight, or the turn is paused on a
 *    provider wait with no decision open.
 *  - `awaiting_hitl` — synchronously waiting on a human (user present).
 *  - `awaiting_hitl_resolution` — paused with a decision open; the user is
 *    absent and the turn persists until the decision is resolved or the turn
 *    is abandoned.
 *  - `awaiting_subsession` — delegated to a child session and suspended until
 *    it settles. Session-level fan-in treats this as active.
 *  - `succeeded`, `failed`, `cancelled` — terminal.
 *
 * The wire form (`WireTurnStatus`) maps both `awaiting_hitl*` members to
 * `awaiting_input`.
 */
export type TurnStatus =
	| 'queued'
	| 'running'
	| 'awaiting_hitl'
	| 'awaiting_hitl_resolution'
	| 'awaiting_subsession'
	| 'succeeded'
	| 'failed'
	| 'cancelled'

/**
 * The configuration a turn runs with.
 *
 * Transitional alias: the definition moves here, under this name, when the
 * cutover deletes the run type directory. Declared now so `Turn` and
 * `TurnMetadata` carry their final shape.
 */
export type TurnConfig = AgentRunConfig

/** The durable subset of {@link TurnConfig} recorded in `turn_started.config`. */
export interface TurnConfigSnapshot {
	model: string
	tokenBudget: number
	timeoutMs: number
	streamIdleTimeoutMs?: number
	maxRequestRichContentBytes?: number
	maxIterations?: number
	temperature?: number
	maxResponseTokens?: number
	costLimitUsd?: number
}

/**
 * The token ledger a turn spends from.
 *
 * Keyed by the ROOT session and the root turn: a root turn opens its own
 * ledger with its own limit, a child session's turns bind to the key of the
 * root turn that spawned them, and a resumed paused turn reuses its key. So a
 * limit that changes between two turns of one session is two ledgers, never a
 * mismatch.
 */
export interface TurnBudgetBinding {
	readonly rootSessionId: SessionId
	readonly rootTurnId: TurnId
	readonly accountId: string
}

/** Which surface opened a session or a turn, and the caller-side ids it used. */
export type OriginProtocol =
	| 'cli'
	| 'sdk'
	| 'ag-ui'
	| 'a2a'
	| 'acp'
	| 'http'
	| 'desktop'
	| 'resident'

/** What kind of work a turn is. A prompt, a goal round, a resident step and a verification step are each a new turn. */
export type TurnOriginKind = 'prompt' | 'goal-round' | 'resident-step' | 'verification'

export interface Origin {
	readonly protocol: OriginProtocol
	/** The caller's own session, thread or context id. Any string; not required to be a UUID. */
	readonly externalSessionId?: string
	/** The caller's own id for this unit of work, such as the id an AG-UI client gives its run. Echoed back verbatim. */
	readonly externalTurnId?: string
	readonly kind?: TurnOriginKind
	readonly goalId?: string
	readonly round?: number
}

/**
 * A caller-side name for a session. The index's `external_refs` table is
 * derived from these (and from `origin`), never written directly, so it
 * survives a rebuild.
 */
export interface ExternalRef {
	readonly protocol: string
	readonly kind: 'session' | 'thread' | 'context'
	/** Any string; no UUID requirement. */
	readonly externalId: string
}

/** Which override, if any, decided a turn's `result`. `model` means the model's own text. */
export type TurnResultSource =
	| 'model'
	| 'guardrail_blocked'
	| 'guardrail_rewritten'
	| 'review'
	| 'outstanding_work'
	| 'structured_output'

/** How a turn ended: carried on `turn_completed` and `turn_failed`. */
export interface TurnSettlement {
	/** `completed` or `cancelled` on `turn_completed`; `failed` on `turn_failed`. */
	readonly status: TurnExecutionStatus
	readonly iterations: number
	/** Usage of this turn only; descendant spend is in the budget summary. */
	readonly usage: TokenUsage
	readonly cost: CostInfo
	readonly durationMs: number
	/** The assistant message holding the answer, after any `message_replaced`. */
	readonly resultMessageId?: MessageId
	readonly resultSource: TurnResultSource
	readonly structuredOutput?: unknown
	/** The provider-chain member that served the end of the turn, when it was not the configured one. */
	readonly servingProvider?: string
	/** Delegated tasks still running when the turn ended. Not cancelled; named. */
	readonly abandonedTaskIds: readonly string[]
	/** Background jobs the model was waiting on that were still running. Not stopped; named. */
	readonly abandonedJobIds: readonly string[]
}

/** Metadata of one turn: who ran it, with what, and where it sits in the session tree. */
export interface TurnMetadata {
	/** This turn's owner, independent of a shared ancestor token account. */
	readonly scope?: {
		readonly tenantId: TenantId
		readonly projectId: ProjectId
		readonly sessionId: SessionId
		readonly turnId: TurnId
	}
	agentId: string
	agentName: string
	config: TurnConfig
	/** The provider the turn was configured with: the head of the chain. */
	provider: string
	/** The chain member the turn was routed to at the end, when not the configured one. */
	servingProvider?: string
	/** Present on a child session's turn: the parent session that delegated it. */
	parentSessionId?: SessionId
	/** Present on a child session's turn: the parent turn whose tool call spawned the child. */
	parentTurnId?: TurnId
	/** Child sessions this turn spawned. */
	childSessionIds?: SessionId[]
}

/** Where a replayed turn was forked from. A fork is always a NEW session. */
export interface TurnForkOrigin {
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly checkpointId: CheckpointId
}

/**
 * One turn of a session, as `query()`, `drainQuery()` and `runAgent()`
 * return it.
 *
 * `messages` is the session's context at settle: the fold of the log, with
 * every `message_replaced` applied. `result` is the authoritative answer,
 * after guardrail, review, outstanding-work and structured-output overrides.
 */
export interface Turn {
	id: TurnId
	sessionId: SessionId
	status: TurnExecutionStatus
	metadata: TurnMetadata
	messages: Message[]
	/** Usage of this turn only; descendant spend is in `budget`. */
	tokenUsage: TokenUsage
	budget?: TokenBudgetSummary
	budgetBinding?: TurnBudgetBinding
	costInfo: CostInfo
	currentIteration: number
	startedAt: number
	endedAt?: number
	stopReason?: StopReason
	lastError?: string
	lastProviderError?: ProviderErrorInfo
	result?: string
	/** Per-iteration record of what the loop did. Absent on a turn that never entered the loop. */
	steps?: readonly StepResult[]
	/** Schema-validated final output, when one was requested and produced. */
	structuredOutput?: unknown
	/** Delegated tasks still running when this turn ended. */
	abandonedTaskIds?: readonly string[]
	/** Background jobs the model awaited that were still running when this turn ended. */
	abandonedJobIds?: readonly string[]
	/** Present on a child session's turn. */
	parentSessionId?: SessionId
	/** Present on a child session's turn. */
	parentTurnId?: TurnId
	depth?: number
	/** Present when this turn's session was forked from another session's checkpoint. */
	forkedFrom?: TurnForkOrigin
}

/** @see Turn */
export type AgentTurn = Turn

/**
 * The state of a session's active turn: the last `turn_started` whose
 * `turnId` has no `turn_completed` or `turn_failed` yet.
 *
 *  - `paused` — its last segment record is `turn_paused`. Only
 *    `resumeSession` (same `turnId`) or `abandonTurn` ends it.
 *  - `running` — a live lease on the session is held.
 *  - `interrupted` — no live lease and not paused: the process that ran it
 *    is gone.
 */
export type ActiveTurnState = 'running' | 'paused' | 'interrupted'

/**
 * A session has at most one active turn. Starting another while one is
 * running, paused or interrupted is refused with this error.
 *
 * Only an `interrupted` turn can be closed automatically, and only when the
 * caller opts in (`beginTurn({ abandonInterrupted: true })`). A paused turn is
 * never closed implicitly. Parallel work uses child sessions or separate
 * sessions.
 */
export class TurnInProgressError extends Error {
	override readonly name = 'TurnInProgressError' as const
	readonly sessionId: SessionId
	readonly activeTurnId: TurnId
	readonly state: ActiveTurnState

	constructor(params: { sessionId: SessionId; activeTurnId: TurnId; state: ActiveTurnState }) {
		const remedy =
			params.state === 'paused'
				? 'Resume it with resumeSession or close it with abandonTurn.'
				: params.state === 'interrupted'
					? 'Its process is gone: resume it, abandon it, or begin the next turn with abandonInterrupted.'
					: 'Wait for it to end, or cancel it.'
		super(
			`Session ${params.sessionId} already has an active turn ${params.activeTurnId} (${params.state}). ${remedy}`,
		)
		this.sessionId = params.sessionId
		this.activeTurnId = params.activeTurnId
		this.state = params.state
	}
}

/**
 * Recognises a {@link TurnInProgressError}, including one from another copy
 * of this package, so a host protocol server can map it to its own error.
 */
export function isTurnInProgressError(value: unknown): value is TurnInProgressError {
	if (value instanceof TurnInProgressError) return true
	if (typeof value !== 'object' || value === null) return false
	const candidate = value as Partial<TurnInProgressError>
	return (
		candidate.name === 'TurnInProgressError' &&
		typeof candidate.sessionId === 'string' &&
		typeof candidate.activeTurnId === 'string' &&
		(candidate.state === 'running' ||
			candidate.state === 'paused' ||
			candidate.state === 'interrupted')
	)
}
