import type { Logger } from '../../utils/logger.js'
import type { ConnectorId, ConnectorInstanceId, MCPClientId, MCPServerId } from '../ids/index.js'
import type {
	ConnectorDefinition,
	ConnectorExecuteParams,
	ConnectorExecuteResult,
	ConnectorInstance,
} from './definition.js'

export type MCPStreamableHttpTransportType = 'streamable_http' | 'streamable-http'

export type MCPTransportType = 'stdio' | 'http-sse' | MCPStreamableHttpTransportType

export interface MCPTransportConfigBase {
	type: MCPTransportType
}

export interface MCPStdioTransportConfig extends MCPTransportConfigBase {
	type: 'stdio'
	command: string
	args?: string[]
	/** Literal values for the child. Highest precedence. */
	env?: Record<string, string>
	/**
	 * Parent variables the child may have, named one at a time.
	 *
	 * The spawn used to pass the whole parent environment, so a server that
	 * needed one token received every credential the host held. It now gets
	 * process plumbing plus what is named here and in `env`, which is what
	 * makes the grant reviewable: the config says which secrets cross the
	 * boundary instead of the answer being "all of them".
	 *
	 * Use this rather than `env` for a credential — `env` puts the value in the
	 * config file, and this keeps it in the environment where it already lives.
	 *
	 * A name the parent does not hold is absent from the child rather than
	 * empty, and does not fail the spawn.
	 */
	inheritEnv?: readonly string[]
	cwd?: string
}

/**
 * Anything that answers like `fetch`, restricted to the request shape the
 * MCP HTTP transports actually send: a URL string, an optional
 * method/headers/body, `redirect` (both transports pin this to `'manual'`
 * so a caller cannot silently re-enable auto-following a redirect), and an
 * abort signal.
 *
 * Structurally identical in spirit to `bridge/a2a/client.ts`'s `FetchLike`
 * — the same injectable, socket-free function shape, so a test needs no
 * socket — but the return type stays the real `Response` rather than that
 * bridge's narrower `{ok, status, json(), text()}` duck type: both MCP
 * transports already read `.headers` (content type, session id) and one of
 * them reads `.body` as a stream (the SSE GET), neither of which the A2A
 * bridge's version exposes. Re-declared here, rather than imported from the
 * A2A bridge, so that bridge is not forced to grow fields it does not use.
 */
export type MCPFetchLike = (
	input: string,
	init?: {
		method?: string
		headers?: Record<string, string>
		body?: string
		redirect?: 'manual' | 'follow' | 'error'
		signal?: AbortSignal
	},
) => Promise<Response>

export interface MCPHttpSseTransportConfig extends MCPTransportConfigBase {
	type: 'http-sse'
	url: string
	headers?: Record<string, string>
	timeoutMs?: number
	/** Injected in place of the ambient global `fetch`. Defaults to it. */
	fetch?: MCPFetchLike
}

export interface MCPStreamableHttpTransportConfig extends MCPTransportConfigBase {
	type: MCPStreamableHttpTransportType
	url: string
	headers?: Record<string, string>
	timeoutMs?: number
	/** Injected in place of the ambient global `fetch`. Defaults to it. */
	fetch?: MCPFetchLike
}

export type MCPTransportUnion =
	| MCPStdioTransportConfig
	| MCPHttpSseTransportConfig
	| MCPStreamableHttpTransportConfig

export interface MCPJsonRpcError {
	code: number
	message: string
	data?: unknown
}

/**
 * A protocol revision this client can still negotiate DOWN to when a server
 * does not speak the current spec, newest first.
 *
 * Kept as a literal union (rather than just `string`) so a caller pattern
 * matching on `McpEra` gets real exhaustiveness checking; the runtime array
 * of the same values lives in `constants/mcp` and is typed against this.
 */
export type McpLegacyVersion = '2025-11-25' | '2025-06-18' | '2025-03-26' | '2024-11-05'

/**
 * A protocol revision this client speaks WITHOUT the `initialize`
 * handshake.
 *
 * A modern connection is stateless: there is no handshake, no session id,
 * and every request carries its own protocol version, client capabilities
 * and client info in `_meta`. `connect()` probes for one before it offers
 * the legacy handshake.
 */
export type McpModernVersion = '2026-07-28'

/**
 * Which family of the wire protocol a connection resolved to, and which
 * exact revision within it.
 *
 * `kind` alone tells a caller which rules apply — whether `_meta` and the
 * stateless per-request shape are in play, or the `initialize` handshake
 * and (for 2025-06-18 and later) the `MCP-Protocol-Version` header — without
 * re-deriving it from the version string on every read.
 *
 * `MCPClient.connect()` resolves this by probing for a modern peer first
 * and falling back to the legacy `initialize` handshake, so which arm a
 * given connection lands on is the server's answer, not a configuration.
 */
export type McpEra =
	| { readonly kind: 'modern'; readonly version: McpModernVersion }
	| { readonly kind: 'legacy'; readonly version: McpLegacyVersion }

/**
 * What a modern server answers `server/discover` with.
 *
 * The modern era's replacement for the `initialize` result: it names the
 * revisions the server speaks, what it can do, and — under the reserved
 * `_meta` key — who it is. Every field is optional on the wire as far as
 * this client is concerned, because the one thing it MUST be able to do
 * with a malformed answer is decline to treat it as proof of a modern peer.
 */
export interface MCPDiscoverResult {
	/** Newest first is conventional but not required; this client sorts. */
	supportedVersions?: readonly string[]
	capabilities?: MCPServerCapabilities
	_meta?: Record<string, unknown>
}

/**
 * Where a resolved {@link McpEra} is remembered between connections.
 *
 * The spec's own guidance: a client SHOULD cache the era for the lifetime
 * of the server process (stdio) or the origin (HTTP) and re-probe if the
 * cached assumption later fails. Without it every connection to a legacy
 * server pays a wasted probe round trip.
 *
 * An interface rather than a module-level `Map` because a process-global
 * cache leaks between tests and would make a conformance suite depend on
 * the order its cases happen to run in. `MCPClientConfig.eraCache` injects
 * one; omitting it uses a process-wide default.
 */
export interface MCPEraCache {
	get(key: string): McpEra | undefined
	set(key: string, era: McpEra): void
	delete(key: string): void
}

export interface MCPJsonRpcMessage {
	jsonrpc: '2.0'
	id?: string | number
	method?: string
	params?: Record<string, unknown>
	result?: unknown
	error?: MCPJsonRpcError
}

/** Authority for one MCP JSON-RPC request. */
export interface MCPRequestOptions {
	/**
	 * Cancels the local wait and asks the peer to stop the correlated request.
	 *
	 * The peer notification is best effort: rejection proves that Namzu stopped
	 * waiting, not that an already-started remote side effect was rolled back.
	 */
	readonly signal?: AbortSignal
	/**
	 * Extra headers for this one request, merged over the transport's static
	 * config headers (a collision resolves to this value) and under this same
	 * call's `bearerToken`, if both are given.
	 *
	 * The protocol's own headers are the exception: `MCP-Protocol-Version`,
	 * `Mcp-Method` and `Mcp-Name` mirror values inside the request this call
	 * is sending, and a server rejects a header that disagrees with the body
	 * it mirrors. A value given here under one of those names — matched
	 * without regard to case — is refused and warn-logged rather than put on
	 * the wire.
	 *
	 * A transport with no header concept (stdio) receives the field and does
	 * nothing with it.
	 */
	readonly headers?: Readonly<Record<string, string>>
	/**
	 * Sent as `Authorization: Bearer <bearerToken>` on this one request.
	 *
	 * Overrides a configured `Authorization` header — static or supplied via
	 * `headers` above — for this request only; it never touches a
	 * differently-named header such as a static `X-API-Key`. Omit it and a
	 * configured `Authorization` header is left exactly as configured.
	 */
	readonly bearerToken?: string
}

/** Authority for one transport write and any response body it consumes. */
export interface MCPTransportSendOptions {
	/** A pre-aborted signal starts no transport work. */
	readonly signal?: AbortSignal
	/**
	 * Extra headers for this one send.
	 *
	 * An HTTP-speaking transport merges these over its static config
	 * headers; a transport with no header concept (stdio) receives the
	 * field and does nothing with it. Introduced so the client — which
	 * alone knows the negotiated era — can ask for `MCP-Protocol-Version`
	 * on a post-initialize request without the transport having to know
	 * what a protocol version is.
	 */
	readonly headers?: Readonly<Record<string, string>>
}

export interface MCPTransport {
	connect(): Promise<void>
	close(): Promise<void>
	send(message: MCPJsonRpcMessage, options?: MCPTransportSendOptions): Promise<void>
	onMessage(handler: (message: MCPJsonRpcMessage) => void): void
	onClose(handler: () => void): void
	onError(handler: (error: Error) => void): void
	isConnected(): boolean
}

export interface MCPJsonSchema {
	type: 'object'
	properties?: Record<string, unknown>
	required?: string[]
	[key: string]: unknown
}

/** A JSON Schema for a value, including non-object tool outputs. */
export interface MCPValueJsonSchema {
	type?: string
	[key: string]: unknown
}

export interface MCPToolAnnotations {
	title?: string
	readOnlyHint?: boolean
	destructiveHint?: boolean
	idempotentHint?: boolean
	openWorldHint?: boolean
}

export interface MCPToolDefinition {
	name: string
	description?: string
	inputSchema: MCPJsonSchema
	/**
	 * The shape the tool returns, as the server declares it.
	 *
	 * Servers publish this on a tool listing regardless of negotiated
	 * protocol revision, and it had no slot here — so a declared return
	 * shape never reached the model at all, which was left inferring one
	 * from prose or from whatever the first call happened to return.
	 */
	outputSchema?: MCPValueJsonSchema
	annotations?: MCPToolAnnotations
	/**
	 * Server-defined data on the tool's own listing entry, carried opaquely:
	 * this client acts on none of it. `mcpToolToToolDefinition` lands it in
	 * `ToolDefinition.metadata` alongside the annotations that have no other
	 * typed home, so a host reading either does not have to reach past this
	 * client's own parsed shape back to the raw listing.
	 */
	_meta?: Record<string, unknown>
}

/**
 * Audience/priority/freshness hints a server may attach to a content block,
 * part of the schema since 2025-06-18. Advisory only: namzu does not act on
 * any of these fields today, but drops none of them either — they survive
 * into `ToolResult.data` for a host that wants to read them.
 *
 * Distinct from {@link MCPToolAnnotations}, which describes a TOOL
 * (read-only, destructive, …); this describes one piece of CONTENT.
 */
export interface MCPContentAnnotations {
	audience?: Array<'user' | 'assistant'>
	priority?: number
	lastModified?: string
}

export type MCPContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string }
	| {
			type: 'resource'
			resource: { uri: string; mimeType?: string; text?: string; blob?: string }
			annotations?: MCPContentAnnotations
	  }
	/** Since 2025-03-26. Raw audio bytes, base64-encoded like `image`. */
	| { type: 'audio'; data: string; mimeType: string }
	/**
	 * Since 2025-06-18. A pointer to a resource the server has NOT embedded
	 * inline — unlike `resource`, which always carries `text` or `blob`.
	 * Because this block carries no content at all, the adapter names it
	 * for the model rather than fabricating text the server never sent.
	 */
	| { type: 'resource_link'; uri: string; name: string; description?: string; mimeType?: string }

export interface MCPToolResult {
	content: MCPContentBlock[]
	isError?: boolean
	/**
	 * A machine-readable payload alongside (or instead of) the content
	 * blocks.
	 *
	 * A server may return this and omit the compatibility text block. The
	 * field survived the wire cast and was read by nothing, so that call
	 * produced an empty tool result for a request that succeeded — with no
	 * diagnostic anywhere, since `isError` was false and the content array
	 * was legitimately empty.
	 */
	structuredContent?: unknown
	_meta?: Record<string, unknown>
}

/**
 * One thing the client would have to do that it never declared it could —
 * elicit input, sample a message, list roots, or something a later spec
 * revision defines. Only `method` is read by this client; every other field
 * is carried opaquely so a shape it does not understand still names itself.
 *
 * namzu declares `clientCapabilities: {}` in every era, so MRTR rule 7 — a
 * server MUST NOT send an `inputRequests` entry for a capability the client
 * did not declare — means a CONFORMING server never produces one of these.
 * The type exists for the defensive path: a non-conforming server's demand
 * is named and refused rather than silently misread as an ordinary result.
 */
export interface MCPInputRequest {
	readonly method: string
	readonly [key: string]: unknown
}

export interface MCPResource {
	uri: string
	name: string
	description?: string
	mimeType?: string
}

export interface MCPResourceTemplate {
	uriTemplate: string
	name: string
	description?: string
	mimeType?: string
}

export interface MCPPromptArgument {
	name: string
	description?: string
	required?: boolean
}

export interface MCPPromptDefinition {
	name: string
	description?: string
	arguments?: MCPPromptArgument[]
}

/**
 * One message of a prompt the server composed.
 *
 * Deliberately its own shape rather than the kernel's `Message`: this is
 * what a remote server said, before anything decides whether to believe it.
 * Converting at the boundary is what keeps a server's `role` from becoming
 * a role in this agent's history by accident — a server that returns an
 * `assistant` message is claiming the agent already said something.
 */
export interface MCPPromptMessage {
	role: 'user' | 'assistant'
	content: MCPContentBlock
}

export interface MCPClientCapabilities {
	roots?: { listChanged?: boolean }
	sampling?: Record<string, never>
	experimental?: Record<string, unknown>
}

export interface MCPServerCapabilities {
	tools?: { listChanged?: boolean }
	resources?: { subscribe?: boolean; listChanged?: boolean }
	prompts?: { listChanged?: boolean }
	logging?: Record<string, never>
	experimental?: Record<string, unknown>
}

export interface MCPInitializeParams {
	protocolVersion: string
	capabilities: MCPClientCapabilities
	clientInfo: { name: string; version: string }
}

export interface MCPInitializeResult {
	protocolVersion: string
	capabilities: MCPServerCapabilities
	serverInfo: { name: string; version?: string }
	/**
	 * The server's own account of how to use it, read off the `initialize`
	 * response verbatim. Only a legacy handshake carries one — the modern
	 * era has no `initialize` round trip, so a modern connection's result
	 * never populates this field (see `completeModernConnection` in
	 * `client.ts`, which synthesises the rest of this shape from a discover
	 * result that has no `instructions` concept at all).
	 *
	 * This is observability data, not steering: nothing in the SDK folds it
	 * into an agent's instruction set automatically. It is server-authored,
	 * remote-party text, and namzu already keeps that class of text out of
	 * instruction/system position (see `connector/mcp/prompt-adapter.ts`
	 * and `frameServerResult` in `connector/mcp/adapter.ts`, which frame
	 * server-supplied prompts and tool results as untrusted data rather
	 * than instructions). A host may display or log this field; it should
	 * not read it into a prompt without the same untrusted framing.
	 */
	instructions?: string
}

export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface MCPClientConfig {
	id?: MCPClientId
	serverName: string
	transport: MCPTransportUnion
	capabilities?: MCPClientCapabilities
	clientInfo?: { name: string; version: string }
	/**
	 * Deadline for a single JSON-RPC round trip. Defaults to
	 * `DEFAULT_MCP_REQUEST_TIMEOUT_MS`.
	 *
	 * Without one, a wedged stdio server left every caller pending
	 * forever — no error, no failure, just a turn that stopped.
	 */
	requestTimeoutMs?: number
	/**
	 * How long `connect()`'s era probe waits for an answer before deciding
	 * the peer speaks a legacy revision. Defaults to
	 * `DEFAULT_MCP_ERA_PROBE_TIMEOUT_MS`.
	 *
	 * Never longer than `requestTimeoutMs`: a probe is a request, and a
	 * probe that outlived the deadline every other request is held to would
	 * be a connect that hangs past its own timeout.
	 */
	eraProbeTimeoutMs?: number
	/**
	 * Where this client reads and records the resolved era.
	 *
	 * Defaults to a process-wide cache shared by every `MCPClient`, which is
	 * the point — two clients reaching the same origin should not each pay a
	 * probe. Inject a fresh one to isolate a test, or a longer-lived one to
	 * scope the memory to a host rather than the process.
	 */
	eraCache?: MCPEraCache
	/**
	 * A pre-built logger. Threaded into the transport `MCPClient` constructs
	 * internally (`createTransport`), so a caller that supplies this gets a
	 * correlated client AND a correlated transport from one field, rather
	 * than each reaching for its own process-default child.
	 */
	logger?: Logger
}

export interface MCPClientState {
	id: MCPClientId
	serverName: string
	status: MCPConnectionStatus
	serverInfo?: { name: string; version?: string }
	serverCapabilities?: MCPServerCapabilities
	/**
	 * The server's `initialize` instructions, captured verbatim. See
	 * {@link MCPInitializeResult.instructions} — legacy handshakes only,
	 * observability only, never auto-folded into an agent's instructions.
	 */
	serverInstructions?: string
	connectedAt?: number
	error?: string
}

export interface MCPServerConfig {
	id?: MCPServerId
	name: string
	version?: string
	capabilities?: Partial<MCPServerCapabilities>
}

export interface MCPServerState {
	id: MCPServerId
	name: string
	running: boolean
	connectedClients: number
	startedAt?: number
}

export interface MCPConnectorBridgeConfig {
	manager: ConnectorManager
	prefix?: string
}

export interface MCPConnectorBridgeToolMapping {
	mcpToolName: string
	connectorId: ConnectorId
	instanceId: ConnectorInstanceId
	methodName: string
}

export interface MCPDiscoveredTool {
	tool: MCPToolDefinition
	clientId: MCPClientId
	serverName: string
}

export type MCPLifecycleEvent =
	| { type: 'mcp_client_connected'; clientId: MCPClientId; serverName: string }
	| { type: 'mcp_client_disconnected'; clientId: MCPClientId }
	| { type: 'mcp_client_error'; clientId: MCPClientId; error: string }
	| { type: 'mcp_server_started'; serverId: MCPServerId }
	| { type: 'mcp_server_stopped'; serverId: MCPServerId }
	| { type: 'mcp_tool_called'; tool: string; clientId?: MCPClientId; serverId?: MCPServerId }
	| { type: 'mcp_tools_changed'; clientId: MCPClientId }

export type MCPEventListener = (event: MCPLifecycleEvent) => void

type ConnectorManager = {
	getInstance(instanceId: ConnectorInstanceId): ConnectorInstance | undefined
	getInstanceConnectorId(instanceId: ConnectorInstanceId): ConnectorId
	getInstanceDefinition(instanceId: ConnectorInstanceId): ConnectorDefinition
	listConnectedInstances(): ConnectorInstance[]
	execute(params: ConnectorExecuteParams): Promise<ConnectorExecuteResult>
}
