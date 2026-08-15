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

export interface MCPHttpSseTransportConfig extends MCPTransportConfigBase {
	type: 'http-sse'
	url: string
	headers?: Record<string, string>
	timeoutMs?: number
}

export interface MCPStreamableHttpTransportConfig extends MCPTransportConfigBase {
	type: MCPStreamableHttpTransportType
	url: string
	headers?: Record<string, string>
	timeoutMs?: number
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

export interface MCPJsonRpcMessage {
	jsonrpc: '2.0'
	id?: string | number
	method?: string
	params?: Record<string, unknown>
	result?: unknown
	error?: MCPJsonRpcError
}

export interface MCPTransport {
	connect(): Promise<void>
	close(): Promise<void>
	send(message: MCPJsonRpcMessage): Promise<void>
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
	outputSchema?: MCPJsonSchema
	annotations?: MCPToolAnnotations
}

export type MCPContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string }
	| { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }

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
	 * forever — no error, no failure, just a run that stopped.
	 */
	requestTimeoutMs?: number
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
	getRegistry(): {
		get(connectorId: ConnectorId): ConnectorDefinition | undefined
		getOrThrow(connectorId: ConnectorId): ConnectorDefinition
	}
	listConnectedInstances(): ConnectorInstance[]
	execute(params: ConnectorExecuteParams): Promise<ConnectorExecuteResult>
}
