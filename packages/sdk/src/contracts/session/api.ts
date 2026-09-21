import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { WireTurnConfig } from './turn.js'

/**
 * `POST /sessions/{id}/turns`: start the next turn of an existing session.
 *
 * A turn begins with a user message, so `message` is required. There is no
 * `agent_id`: the session's agent is fixed when the session starts, and a
 * turn cannot switch it.
 *
 * A session has at most one active turn. A host answers a request that
 * arrives while one is running, paused or interrupted with a conflict that
 * names the active turn.
 */
export interface CreateTurnRequest {
	message: string
	config: WireTurnConfig
	env?: Record<string, string>
	stream?: boolean
}

/**
 * A session that exists for one turn: the session and its first turn are
 * created together, and the client never addresses the session again.
 */
export interface CreateEphemeralSessionRequest {
	agent_id: string
	message: string
	config: WireTurnConfig
	env?: Record<string, string>
}

/** The turn lifecycle events on a session stream, in lifecycle order. */
export const TURN_STREAM_EVENT_TYPES = [
	'turn.started',
	'turn.completed',
	'turn.failed',
	'turn.cancelled',
	'turn.paused',
	'turn.resuming',
] as const

export type TurnStreamEventType = (typeof TURN_STREAM_EVENT_TYPES)[number]

/** Every event name a session stream (SSE) carries. */
export type SessionStreamEventType =
	| TurnStreamEventType
	| 'iteration.started'
	| 'iteration.completed'
	/**
	 * Who answers when this turn asks a human, changed mid-turn.
	 *
	 * Wire-visible for the same reason `compaction.completed` is: an operator
	 * watching a live turn needs to see supervision loosen, not infer it from
	 * approvals that stopped arriving. Names only; the wire cannot carry a
	 * handler.
	 */
	| 'approval_policy.changed'
	/**
	 * A compaction pass replaced a span of history with a summary. Wire-
	 * visible because the operation is destructive: a client rendering the
	 * transcript needs to know its middle was dropped, not infer it.
	 */
	| 'compaction.completed'
	/** Oversized tool results were emptied instead of the history summarized. */
	| 'compaction.tool_results_cleared'
	| 'memory.consolidated'
	| 'background_job.exited'
	| 'compaction.failed'
	/** A guardrail refused or corrected the turn. */
	| 'guardrail.triggered'
	/**
	 * Extended-thinking lifecycle. Wire-visible because without it a client
	 * renders a multi-second stall with no events while the model is working.
	 */
	| 'reasoning.started'
	| 'reasoning.delta'
	| 'reasoning.completed'
	/**
	 * A model call failed transiently and is being retried after a backoff.
	 * Without it a client sees no event and no keepalive for the whole
	 * backoff, so a turn that is about to succeed looks like one that hung.
	 */
	| 'provider.retry'
	| 'hosted.tool'
	/**
	 * A member of the provider chain could not serve and a later member took
	 * over. Without it a client cannot know the answer it is reading came from
	 * a provider it did not ask for, at a different price.
	 */
	| 'provider.fallback'
	| 'tool.executing'
	/** Ephemeral progress from a long-running tool. Not in the transcript. */
	| 'tool.progress'
	| 'tool.completed'
	| 'tool.error'
	| 'tool.input_started'
	| 'tool.input_delta'
	| 'tool.input_completed'
	| 'token.usage'
	| 'message.created'
	| 'message.delta'
	| 'message.completed'
	/**
	 * A tool asked the user a question and the turn is parked on it. A client
	 * cannot render an approval card for something it never hears about.
	 */
	| 'question.asked'
	| 'question.answered'
	| 'review.requested'
	| 'review.completed'
	| 'checkpoint.created'
	| 'activity.created'
	| 'activity.updated'
	| 'plan.ready'
	| 'plan.approved'
	| 'plan.rejected'
	| 'plan.step_updated'
	| 'plan.completed'
	| 'plan.failed'
	| 'agent.pending'
	| 'agent.completed'
	| 'agent.failed'
	| 'agent.canceled'
	| 'task.created'
	| 'task.updated'
	| 'plugin.hook_executing'
	| 'plugin.hook_completed'
	| 'sandbox.created'
	| 'sandbox.exec'
	| 'sandbox.destroyed'

/** One event on a session stream. */
export interface SessionStreamEvent {
	event: SessionStreamEventType
	data: Record<string, unknown>
}

/** The ids every `turn.*` payload carries. */
export interface TurnStreamEventData {
	session_id: SessionId
	turn_id: TurnId
	[key: string]: unknown
}

/** A `turn.*` event: its payload always names the session and the turn. */
export interface TurnStreamEvent extends SessionStreamEvent {
	event: TurnStreamEventType
	data: TurnStreamEventData
}
