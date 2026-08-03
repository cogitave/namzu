/**
 * The protocol version this client ADVERTISES in `initialize`.
 *
 * Deliberately the version namzu actually implements, not the newest one
 * published. Advertising a version whose requirements are unimplemented is
 * worse than advertising an older one honestly: the server tailors its
 * behavior to what the client claims, and the mismatch surfaces later as
 * a malformed exchange rather than a clean negotiation failure. Raising
 * this is a conformance task, not a constant edit.
 */
export const MCP_PROTOCOL_VERSION = '2024-11-05'

/**
 * Versions this client can speak if a server negotiates down (or up) to
 * one of them, newest first.
 *
 * A server is free to answer `initialize` with a version other than the one
 * the client asked for — that is how the handshake is specified. namzu used
 * to ignore the answer entirely and carry on regardless, so a server
 * responding with a version we cannot speak looked exactly like a
 * successful connection until something downstream broke oddly.
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2024-11-05']

/**
 * Default deadline for one MCP JSON-RPC round trip.
 *
 * Generous enough for a server that shells out or hits a network API,
 * short enough that an unresponsive one surfaces as an error the model
 * can react to rather than a hang.
 */
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000

/** JSON-RPC 2.0 reserved code for an unimplemented method. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601
