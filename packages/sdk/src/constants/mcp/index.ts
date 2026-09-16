import type { McpLegacyVersion, McpModernVersion } from '../../types/connector/mcp.js'

/**
 * The current MCP spec revision, as this client DECLARES it — not yet as
 * something it negotiates.
 *
 * `connect()` does not offer this in an `initialize` request: the modern
 * era removes that handshake entirely, and namzu does not yet speak the
 * stateless per-request shape a modern origin requires. It is declared here
 * so `MCP_SUPPORTED_PROTOCOL_VERSIONS` below has a place to grow into once
 * a later workstream builds the negotiation that actually reaches it.
 */
export const MCP_MODERN_VERSIONS: readonly McpModernVersion[] = ['2026-07-28']

/**
 * Protocol versions this client offers and accepts through the legacy
 * `initialize` handshake, newest first.
 *
 * `connect()` offers `MCP_LEGACY_VERSIONS[0]` — the newest one — in a
 * single `initialize` request. A server is free to answer with any version
 * in `MCP_SUPPORTED_PROTOCOL_VERSIONS` below, not only the one offered:
 * that is how the handshake is specified. namzu used to advertise and
 * accept only `2024-11-05`, which refused the overwhelming majority of
 * servers deployed since — every one that negotiated down to 2025-03-26,
 * 2025-06-18 or 2025-11-25 instead of all the way to the oldest revision.
 *
 * This is deliberately a single round trip, never a per-version waterfall:
 * the spec's own backward-compatibility algorithm offers one version and
 * honors whatever the server answers
 * (https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).
 * A three-step retry loop is three times the latency for a code path no
 * server expects, and `protocol-negotiation.test.ts` counts `initialize`
 * frames so nobody reintroduces one.
 */
export const MCP_LEGACY_VERSIONS: readonly McpLegacyVersion[] = [
	'2025-11-25',
	'2025-06-18',
	'2025-03-26',
	'2024-11-05',
]

/**
 * Every protocol version this client can speak, in any capacity — offered
 * in `initialize`, or merely a value it will not refuse if a server
 * answers with it.
 *
 * The single authority for "can we speak this?": a server negotiating to
 * a version outside this list is refused rather than let through to break
 * confusingly downstream. Advertising or accepting a version whose
 * requirements are unimplemented is worse than being honest about a
 * narrower set — the server tailors its behavior to what the client
 * claims, and the mismatch would otherwise surface later as a malformed
 * exchange instead of a clean negotiation failure. That reasoning is why
 * this list once held a single entry; it now argues for the broadened set
 * above, not against it, because every version listed here is one namzu
 * has actually verified it can carry a legacy `initialize` handshake for.
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
	...MCP_MODERN_VERSIONS,
	...MCP_LEGACY_VERSIONS,
]

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

/**
 * JSON-RPC codes a server may use to say "that resource does not exist".
 *
 * The current spec's resource-read error path uses the application-defined
 * `-32002`, but a server on an older version may still answer with the
 * generic `-32602` ("Invalid params") for the same condition — and the spec
 * explicitly says a client SHOULD keep accepting it. Both are listed so a
 * caller distinguishing "not found" from "actually broken" does not have to
 * special-case the older code itself.
 */
export const RESOURCE_NOT_FOUND_CODES: readonly number[] = [-32602, -32002]
