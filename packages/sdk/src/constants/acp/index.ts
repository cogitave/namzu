/**
 * The agent-client protocol's version and method set, pinned.
 *
 * A table rather than string literals scattered through the server, because
 * the two things that go wrong with a wire protocol are a method spelled
 * differently in one place and a method implemented but never advertised.
 * Both are invisible at compile time and both present to a client as "that
 * agent does not support this".
 *
 * `bridge/acp/server.ts` authors its handler map independently and a test
 * compares the two SETS in both directions: a handler with no entry here
 * fails, and an entry here with no handler fails. That is the only
 * arrangement where the comparison can fail — deriving the handlers from
 * this table would make the test a tautology, which is the shape
 * `a-check-that-cannot-fail` names.
 *
 * Zero imports, deliberately: this is read by the types module, the server,
 * and the CLI command, and a constant table that pulls in a dependency
 * becomes a cycle the moment one of those three moves.
 */

/**
 * The protocol revision this bridge speaks.
 *
 * A number, matching the wire field, and pinned rather than negotiated
 * downward. A client asking for a version this does not implement is told
 * what it does implement; guessing that an older client can be served by a
 * newer agent is how a protocol bridge produces a session that half works.
 */
export const ACP_PROTOCOL_VERSION = 1

/** Methods a client calls on this agent. */
export const ACP_METHODS = {
	INITIALIZE: 'initialize',
	SESSION_NEW: 'session/new',
	SESSION_PROMPT: 'session/prompt',
	SESSION_CANCEL: 'session/cancel',
	SESSION_LOAD: 'session/load',
} as const

export type AcpMethod = (typeof ACP_METHODS)[keyof typeof ACP_METHODS]

/**
 * Notifications this agent sends the client.
 *
 * Separate from `ACP_METHODS` because the drift test is about what a client
 * may CALL. Mixing the two directions into one table would make that test
 * demand a handler for a message this side only ever sends.
 */
export const ACP_CLIENT_NOTIFICATIONS = {
	SESSION_UPDATE: 'session/update',
} as const

/**
 * REQUESTS this agent makes of the client, which it answers.
 *
 * Distinct from a notification: each carries an id and this side waits for
 * the response. That direction is what makes a permission prompt possible at
 * all — the agent has a question and cannot proceed until the human behind
 * the client answers it.
 */
export const ACP_CLIENT_REQUESTS = {
	REQUEST_PERMISSION: 'session/request_permission',
	FS_READ: 'fs/read_text_file',
	FS_WRITE: 'fs/write_text_file',
} as const

/**
 * JSON-RPC error codes this bridge answers with.
 *
 * `METHOD_NOT_FOUND` is the one with a behavioural requirement attached: an
 * unknown method is answered and the connection STAYS OPEN. A bridge that
 * closed on an unrecognised call would make a client's feature probe fatal.
 */
export const ACP_ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
} as const

/**
 * The capability a client must declare before a session is created.
 *
 * Approval routing is a later change, so a session that could not ask a
 * human anything must not be created at all: it would run with every tool
 * auto-approved, which is not a degraded version of asking — it is the
 * opposite of it. The refusal names this string so a client author knows
 * what to send.
 */
export const ACP_PERMISSION_CAPABILITY = 'permission'

/**
 * The capability that lets the EDITOR's buffers be the source of truth.
 *
 * Optional, unlike `permission`. A client that does not declare it gets an
 * agent reading and writing the disk, which is correct and is what every
 * non-editor peer wants. A client that DOES declare it is telling this
 * agent that the file on disk may be stale — the user has unsaved changes —
 * and that reading disk anyway would show the model a version of the file
 * nobody is looking at.
 */
export const ACP_FILESYSTEM_CAPABILITY = 'fs'
