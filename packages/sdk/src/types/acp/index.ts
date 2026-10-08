import type { ReviewMode } from '../../runtime/query/review-policy.js'
import type { SerializableHostCommand } from '../command/index.js'
import type { AssistantTextPart, DocumentAttachment, ImageAttachment } from '../message/index.js'
import type { ReasoningEffort } from '../provider/chat.js'
import type { MessageStopReason } from '../session/stop-reason.js'
import type { TaskStatus } from '../task/index.js'
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
	/** True only when the host gateway opts into inline user attachment delivery. */
	readonly promptAttachments?: boolean
	/** True only when this host applies captured effort and review settings per prompt. */
	readonly promptOptions?: boolean
	/** Optional, explicitly installed Namzu host methods; core ACP peers can ignore them. */
	readonly extensions?: readonly string[]
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

/**
 * The file change a pending `edit` or `write` call would make, computed by the
 * agent with the tool's own apply code against the file as it is now.
 *
 * Optional on the wire: an older client ignores it, and an agent that cannot
 * establish it (a binary or oversized file, a path outside the turn's roots, a
 * call the tool would refuse) simply omits it.
 */
export interface AcpFileChangePreview {
	/** The absolute path the tool resolves the call's `path` to. */
	readonly path: string
	/** The current body, or `null` when the call would create the file. */
	readonly before: string | null
	/** The body after the call. */
	readonly after: string
	/** True when `before` and `after` were cut to a bounded size. */
	readonly truncated?: boolean
}

/** What the agent asks the client before running a tool batch. */
export interface AcpRequestPermissionParams {
	readonly sessionId: string
	readonly toolCalls: readonly {
		readonly id: string
		readonly name: string
		readonly input: unknown
		readonly isDestructive: boolean
		/** For `edit` and `write` calls, when the agent could compute it. */
		readonly preview?: AcpFileChangePreview
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
	/**
	 * For a rejection: set by a client that is reporting a person's No, so
	 * the session record can say the call was declined by them rather than
	 * refused by policy. `note` is what they said, without any wrapper the
	 * client put around it in `feedback`, which is for the model. A bare
	 * `reject` without this is recorded as it always was.
	 */
	readonly declined?: { readonly note?: string }
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

export interface AcpPromptOptions {
	readonly effort?: ReasoningEffort
	readonly permissionMode?: ReviewMode
}
export interface AcpSessionPromptParams {
	readonly sessionId: string
	/** The operator's message, already plain text. */
	readonly prompt: string
	/** Inline user-owned bytes; store references are not admitted across this boundary. */
	readonly attachments?: readonly (ImageAttachment | DocumentAttachment)[]
	readonly options?: AcpPromptOptions
}

/** Why a prompt stopped, in the peer's vocabulary. */
export type AcpStopReason = 'end_turn' | 'cancelled' | 'refused' | 'error' | 'max_turns'

export interface AcpSessionPromptResult {
	readonly stopReason: AcpStopReason
	/** Exact runtime reason, when available; a cancelled preparation also names cancellation. */
	readonly reason?: string
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
	| {
			readonly kind: 'agent_message_chunk'
			readonly text: string
			readonly messageId?: string
			readonly turnId?: string
			readonly iteration?: number
			/** Public provider phase only; absent means the provider did not name one. */
			readonly phase?: AssistantTextPart['phase']
			readonly textPart?: Omit<AssistantTextPart, 'text'>
	  }
	/** A completed message; content selects the provider's explicit final-answer parts. */
	| {
			readonly kind: 'agent_message'
			readonly status: 'completed'
			readonly messageId?: string
			readonly turnId?: string
			readonly iteration?: number
			readonly content?: string
			readonly textParts?: readonly AssistantTextPart[]
			readonly stopReason: MessageStopReason
	  }
	/** A fragment of the assistant's reasoning, when the model emits any. */
	| {
			readonly kind: 'agent_thought_chunk'
			readonly text: string
			readonly messageId?: string
			readonly turnId?: string
			readonly iteration?: number
			readonly blockId?: string
	  }
	/** Reasoning boundaries also represent redacted blocks, without exposing their payload. */
	| {
			readonly kind: 'agent_thought'
			readonly status: 'pending' | 'completed'
			readonly messageId?: string
			readonly turnId?: string
			readonly iteration?: number
			readonly blockId?: string
	  }
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
			/** Runtime-measured execution duration, present on completed calls when known. */
			readonly durationMs?: number
			/** Live progress for this call; preserve its prior presentation while updating. */
			readonly progress?: {
				readonly message: string
				readonly fraction?: number
			}
	  }
	/** The turn is over. Carries the same reason the prompt result will. */
	| {
			readonly kind: 'turn_ended'
			readonly stopReason: AcpStopReason
			readonly error?: string
			readonly turnId?: string
			/** The settled answer's actual message identity, when the runtime recorded one. */
			readonly messageId?: string
			/** Exact runtime reason; for example, paused remains distinct from cancelled. */
			readonly reason?: string
			/** Authoritative settled answer. An empty string deliberately clears rejected output. */
			readonly result?: string
	  }

export interface AcpSessionUpdateNotification {
	readonly sessionId: string
	readonly update: AcpSessionUpdate
}

/** A full replacement row from the existing session planning-task store. */
export interface AcpTask {
	readonly taskId: string
	readonly subject: string
	readonly status: TaskStatus
	/** An explicit empty list clears prior dependencies. */
	readonly blockedBy: readonly string[]
	/** Absence clears any previously displayed owner. */
	readonly owner?: string
	/** What the task reads as while it is being worked on, such as "Running the tests". */
	readonly activeForm?: string
}

/** Optional Namzu planning notification; distinct from delegated worker state. */
export interface AcpTaskUpdate {
	readonly sessionId: string
	readonly task: AcpTask
	readonly deleted?: true
}
