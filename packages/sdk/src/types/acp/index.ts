import type { SerializableHostCommand } from '../command/index.js'
import type { ToolCallView } from '../tool/presentation.js'

/**
 * The wire shapes an editor or an orchestrator sees.
 *
 * Declared here rather than inferred from the server's own returns, because
 * these cross a process boundary: a shape that only exists as a function's
 * inferred return type is a contract nobody can read, and the reader is
 * frequently writing the client in another language.
 *
 * Everything here is JSON. No `Date`, no `Map`, no branded id reaching the
 * wire as anything but a string — a peer cannot construct a branded id and
 * should not have to.
 */

/** What the client says it can do. */
export interface AcpClientCapabilities {
	/**
	 * Capability names the client supports.
	 *
	 * An array of strings rather than a booleans object, so a client can
	 * declare a capability this agent has not heard of without the field
	 * being dropped by a parser that only knew the old shape.
	 */
	readonly capabilities?: readonly string[]
}

export interface AcpInitializeParams extends AcpClientCapabilities {
	/** The revision the client speaks. */
	readonly protocolVersion?: number
	/** Free-form, for logs. Never used to vary behaviour. */
	readonly clientInfo?: { readonly name?: string; readonly version?: string }
}

export interface AcpInitializeResult {
	readonly protocolVersion: number
	readonly agentInfo: { readonly name: string; readonly version: string }
	/**
	 * The commands a client may offer its operator.
	 *
	 * Comes from `HostCommandRegistry.describe()`, never hand-written here.
	 * A front end that authored its own list would be a second definition of
	 * the command surface, and the one that drifted would be the one an
	 * operator was looking at.
	 */
	readonly commands: readonly SerializableHostCommand[]
	/** Which capabilities this agent needs the client to have. */
	readonly requiredClientCapabilities: readonly string[]
	/**
	 * Capabilities that change what this agent can do without being required.
	 *
	 * Kept apart from `required` because demanding a filesystem of a peer that
	 * is not an editor would refuse a session that is perfectly able to run.
	 */
	readonly optionalClientCapabilities: readonly string[]
}

export interface AcpSessionNewParams {
	/** Where the agent works. Absent means the process's own directory. */
	readonly cwd?: string
}

export interface AcpSessionNewResult {
	readonly sessionId: string
}

export interface AcpSessionLoadParams {
	/** The session to resume. Answered with the SAME id, never a new one. */
	readonly sessionId: string
	readonly cwd?: string
}

/** What the agent asks the client before running a tool batch. */
export interface AcpRequestPermissionParams {
	readonly sessionId: string
	readonly toolCalls: readonly {
		readonly id: string
		readonly name: string
		readonly input: unknown
		readonly isDestructive: boolean
	}[]
}

/**
 * The client's answer.
 *
 * `approve_all` is a distinct outcome rather than `approve` plus a flag,
 * because the two mean different things to the human who chose one and a
 * boolean beside an enum invites a client to send `approve` with the flag on.
 */
export interface AcpRequestPermissionResult {
	readonly outcome: 'approve' | 'approve_all' | 'reject'
	/** Why, for a rejection. Reaches the MODEL, so it is worth writing. */
	readonly feedback?: string
}

export interface AcpFsReadParams {
	readonly sessionId: string
	readonly path: string
}

export interface AcpFsReadResult {
	readonly content: string
}

export interface AcpFsWriteParams {
	readonly sessionId: string
	readonly path: string
	readonly content: string
}

export interface AcpSessionPromptParams {
	readonly sessionId: string
	/** The operator's message, already plain text. */
	readonly prompt: string
}

/** Why a prompt stopped, in the peer's vocabulary. */
export type AcpStopReason = 'end_turn' | 'cancelled' | 'refused' | 'error' | 'max_turns'

export interface AcpSessionPromptResult {
	readonly stopReason: AcpStopReason
}

export interface AcpSessionCancelParams {
	readonly sessionId: string
}

/**
 * One streamed update.
 *
 * A discriminated union on `kind`, and closed: an open one would let this
 * bridge emit an update shape no client can render, which fails silently at
 * the far end — the same reason `ToolCallView` is closed.
 */
export type AcpSessionUpdate =
	/** A fragment of the assistant's answer. */
	| { readonly kind: 'agent_message_chunk'; readonly text: string }
	/** A fragment of the assistant's reasoning, when the model emits any. */
	| { readonly kind: 'agent_thought_chunk'; readonly text: string }
	/**
	 * A tool call, rendered by the TOOL rather than by this bridge.
	 *
	 * `view` is a `ToolCallView` verbatim. This module never compares a tool
	 * name: the moment a front end writes `name === 'edit'`, a tool it has
	 * not heard of can never be shown properly, which is the defect
	 * `createToolPresenter` exists to have fixed once.
	 */
	| {
			readonly kind: 'tool_call'
			readonly toolCallId: string
			readonly title: string
			readonly status: 'pending' | 'completed' | 'failed'
			readonly view: ToolCallView
	  }
	/** The turn is over. Carries the same reason the prompt result will. */
	| { readonly kind: 'turn_ended'; readonly stopReason: AcpStopReason }

export interface AcpSessionUpdateNotification {
	readonly sessionId: string
	readonly update: AcpSessionUpdate
}
