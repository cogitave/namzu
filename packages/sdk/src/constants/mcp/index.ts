export const MCP_PROTOCOL_VERSION = '2024-11-05'

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
