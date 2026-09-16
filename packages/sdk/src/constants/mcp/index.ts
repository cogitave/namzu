import type { McpLegacyVersion, McpModernVersion } from '../../types/connector/mcp.js'

/**
 * The MCP spec revisions this client speaks WITHOUT the `initialize`
 * handshake, newest first.
 *
 * The modern era removes that handshake entirely: a connection is resolved
 * by probing with `server/discover`, and every request afterwards carries
 * its own protocol version, client capabilities and client info in `_meta`
 * instead of inheriting them from a session. `connect()` tries the newest
 * entry here FIRST and falls back to the legacy handshake below only when
 * the probe says the peer does not speak it.
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

/**
 * The method a modern server answers with its `DiscoverResult`.
 *
 * Mandatory for a 2026-07-28 server and optional for a client, which is
 * exactly what makes it a usable era probe: a server that answers it speaks
 * the modern protocol, and a legacy server answers it with an
 * implementation-defined error — commonly `-32601` or `-32602` — or not at
 * all.
 */
export const MCP_DISCOVER_METHOD = 'server/discover'

/**
 * How long an era probe waits for an answer before deciding the peer is
 * legacy.
 *
 * A heuristic with no good universal value, which is why it is
 * configurable per client (`MCPClientConfig.eraProbeTimeoutMs`). Too short
 * and a slow-starting server is misclassified as legacy; too long and every
 * legacy server pays the wait on every connect. Two seconds is long enough
 * for a process that has already spawned to answer one request and short
 * enough to sit comfortably inside an operator-facing connect deadline —
 * and the era cache means a given origin or command pays it once, not once
 * per connection.
 */
export const DEFAULT_MCP_ERA_PROBE_TIMEOUT_MS = 2_000

/**
 * The HTTP statuses a legacy origin answers a modern request with.
 *
 * A status alone is NOT the fallback signal: a modern server answers an
 * unknown method with `404` and a JSON-RPC `-32601` body specifically so a
 * client can tell it apart from the `404` of a server that has never heard
 * of the modern protocol. The body decides; this list only says which
 * responses are worth reading a body from.
 */
export const MCP_MODERN_HTTP_FALLBACK_STATUSES: readonly number[] = [400, 404, 405]

/**
 * The reserved `_meta` keys a modern request and reply carry.
 *
 * `protocolVersion` and `clientCapabilities` are REQUIRED on every modern
 * request; `clientInfo` is a SHOULD. `serverInfo` travels the other way —
 * it is how a `DiscoverResult` names the peer, and is what `connect()`
 * reads to synthesise the `MCPInitializeResult` a host still expects.
 */
export const MCP_META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const MCP_META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
export const MCP_META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const MCP_META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

/**
 * The request headers a modern Streamable HTTP request mirrors its body
 * with, so an intermediary can route and authorise a call without parsing
 * JSON-RPC.
 *
 * `MCP_PROTOCOL_VERSION_HEADER` is shared with the later legacy revisions,
 * where it means the version negotiated by `initialize` rather than the one
 * carried in this request's own `_meta`.
 */
export const MCP_PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version'
export const MCP_METHOD_HEADER = 'Mcp-Method'
export const MCP_NAME_HEADER = 'Mcp-Name'
export const MCP_PARAM_HEADER_PREFIX = 'Mcp-Param-'

/**
 * The methods whose target is named in the `Mcp-Name` header, and the
 * parameter each one's name is read from.
 *
 * Required for compliance on Streamable HTTP: an intermediary that can see
 * WHICH tool is being called without reading the body is the whole point of
 * mirroring it into a header.
 */
export const MCP_NAME_HEADER_METHODS: Readonly<Record<string, 'name' | 'uri'>> = {
	'tools/call': 'name',
	'prompts/get': 'name',
	'resources/read': 'uri',
}
