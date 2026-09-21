import type { ProjectId, SessionId, TurnId } from '../../types/ids/index.js'
import type { Turn } from '../../types/session/turn.js'
import type { ApiPermissionMode, ISOTimestamp } from '../api.js'
import type { WireTurnStatus } from './turn-status.js'

/**
 * Why a turn stopped, as the wire's `stop_reason` field carries it.
 *
 * The domain stop reason under a wire name, so the HTTP field stays decoupled
 * from the internal type's identifier.
 */
export type TurnStopReason = NonNullable<Turn['stopReason']>

/** The per-turn configuration a client may set. Every field is optional; the agent's defaults fill the rest. */
export interface WireTurnConfig {
	model?: string
	temperature?: number
	tokenBudget?: number
	maxResponseTokens?: number
	timeoutMs?: number
	streamIdleTimeoutMs?: number
	maxRequestRichContentBytes?: number
	permissionMode?: ApiPermissionMode
	systemPrompt?: string
}

/** What one turn spent. Usage of this turn only; child sessions report their own. */
export interface WireTurnUsage {
	input_tokens: number
	output_tokens: number
	total_tokens: number
	total_cost_usd?: number
}

/**
 * One turn of a session, as HTTP, SSE and A2A payloads carry it.
 *
 * A turn always belongs to a session: `session_id` is required. A child
 * session's turn names the parent session and the parent turn whose tool call
 * spawned it; `child_session_ids` lists the child sessions this turn spawned.
 */
export interface WireTurn {
	turn_id: TurnId
	session_id: SessionId
	project_id: ProjectId | null
	agent_id: string
	agent_name?: string
	status: WireTurnStatus
	stop_reason?: TurnStopReason
	created_at: ISOTimestamp
	started_at?: ISOTimestamp
	completed_at?: ISOTimestamp
	duration_ms?: number
	model?: string
	config: WireTurnConfig
	usage?: WireTurnUsage
	iterations?: number
	/** The authoritative answer, after guardrail, review and structured-output overrides. */
	result?: string
	last_error?: string
	/** Present on a child session's turn: the session that delegated it. */
	parent_session_id?: SessionId
	/** Present on a child session's turn: the parent turn whose tool call spawned the child. */
	parent_turn_id?: TurnId
	depth?: number
	child_session_ids?: SessionId[]
}
