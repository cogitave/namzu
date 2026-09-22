import type { SessionId, TurnId } from '../ids/index.js'
import type { LLMToolSchema } from '../tool/index.js'

/**
 * A conversation with no turn boundary.
 *
 * Every other seam in this kernel is turn-based by construction: a turn
 * has iterations, an iteration sends a complete message list and reads a
 * stream back, and a checkpoint is taken between two of them. That shape
 * is load-bearing everywhere it appears and it cannot describe a duplex
 * session, where input keeps arriving while output is still being
 * produced and "the turn" is not a thing either side can point at.
 *
 * So this is a second contract rather than a widening of the first. The
 * alternative — bending `chatStream` until it accepts a live input
 * channel — would put a half-duplex assumption inside every consumer of
 * the turn-based path in exchange for a duplex path that still would not
 * fit.
 *
 * What is here: the driver contract, the session loop that runs tools
 * against it, and a scripted driver so both are exercised. What is NOT
 * here, and deliberately: audio capture and playback, which belong to
 * whatever owns the microphone, and checkpoint/resume, which has no
 * meaning yet for a session whose state lives on the far side of a
 * socket.
 */

export type BidiInput =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'audio'; readonly data: string; readonly mediaType: string }

/**
 * What the far side reports.
 *
 * `interrupted` is the event that makes this contract different from the
 * turn-based one. In a duplex session the human can speak over the model,
 * and everything the model was in the middle of — text it was emitting, a
 * tool it just asked for — is now answering a question nobody is asking.
 * A driver that cannot detect that never emits it and the loop behaves as
 * if the model always finished what it started.
 */
export type BidiEvent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'audio'; readonly data: string; readonly mediaType: string }
	| {
			readonly type: 'tool_call'
			/** Unique for the complete session; a duplicate is a protocol failure. */
			readonly id: string
			readonly name: string
			/** JSON, as the model produced it. */
			readonly arguments: string
	  }
	/** The model finished a stretch of output and is waiting. */
	| { readonly type: 'turn_complete' }
	/**
	 * The human spoke over the model; work that has not started publishing a
	 * result is now stale. This is not run cancellation: tool code keeps its
	 * live signal so an irreversible side effect is not stopped halfway.
	 */
	| { readonly type: 'interrupted' }
	| { readonly type: 'error'; readonly message: string }
	| { readonly type: 'closed'; readonly reason?: string }

export interface BidiConnectParams {
	readonly model: string
	readonly system?: string
	readonly tools?: readonly LLMToolSchema[]
	/**
	 * Lifetime of the host-owned run. A provider uses it for connection and
	 * ongoing transport work; the host also invokes `close()` when it aborts.
	 */
	readonly signal?: AbortSignal
}

export interface BidiSession {
	/** Push input from the human. Never waits for the model to be idle. */
	send(input: BidiInput): Promise<void>
	/**
	 * Answer a `tool_call`.
	 *
	 * Separate from {@link send} because it is not input from the human:
	 * a driver has to attach it to the call it answers, and a session that
	 * received it as ordinary input would have to guess.
	 *
	 * Atomically publish one result. Entering this call is the commit point:
	 * a later conversational interruption cannot recall it. Resolve only after
	 * the provider accepted the result; reject when it did not.
	 */
	sendToolResult(id: string, output: string, isError?: boolean): Promise<void>
	events(): AsyncIterable<BidiEvent>
	/** Stop the event stream and release provider resources. Called at most once. */
	close(): Promise<void>
}

export interface BidiProvider {
	readonly id: string
	connect(params: BidiConnectParams): Promise<BidiSession>
}

/** What the loop reports back to whoever is driving it. */
export type BidiTurnEvent =
	| {
			readonly type: 'text'
			readonly sessionId: SessionId
			readonly turnId: TurnId
			readonly text: string
	  }
	| {
			readonly type: 'audio'
			readonly sessionId: SessionId
			readonly turnId: TurnId
			readonly data: string
			readonly mediaType: string
	  }
	| {
			readonly type: 'tool_started'
			readonly sessionId: SessionId
			readonly turnId: TurnId
			readonly toolUseId: string
			readonly toolName: string
	  }
	| {
			readonly type: 'tool_completed'
			readonly sessionId: SessionId
			readonly turnId: TurnId
			readonly toolUseId: string
			readonly toolName: string
			readonly output: string
			readonly isError: boolean
	  }
	/**
	 * A tool's answer was thrown away because the human interrupted before
	 * publication began. The operation itself may have run to completion.
	 */
	| {
			readonly type: 'tool_abandoned'
			readonly sessionId: SessionId
			readonly turnId: TurnId
			readonly toolUseId: string
			readonly toolName: string
	  }
	| { readonly type: 'turn_complete'; readonly sessionId: SessionId; readonly turnId: TurnId }
	| { readonly type: 'interrupted'; readonly sessionId: SessionId; readonly turnId: TurnId }
	| {
			readonly type: 'error'
			readonly sessionId: SessionId
			readonly turnId: TurnId
			readonly message: string
	  }
	| {
			readonly type: 'closed'
			readonly sessionId: SessionId
			readonly turnId: TurnId
			readonly reason?: string
	  }
