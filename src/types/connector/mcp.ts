import type { ConnectorId, ConnectorInstanceId, MCPClientId, MCPServerId } from '../ids/index.js'
import type {
	ConnectorDefinition,
	ConnectorExecuteParams,
	ConnectorExecuteResult,
	ConnectorInstance,
} from './definition.js'

export type MCPTransportType = 'stdio' | 'http-sse'

export interface MCPTransportConfigBase {
	type: MCPTransportType
}

export interface MCPStdioTransportConfig extends MCPTransportConfigBase {
	type: 'stdio'
	command: string
	args?: string[]
	env?: Record<string, string>
	cwd?: string
}

export interface MCPHttpSseTransportConfig extends MCPTransportConfigBase {
	type: 'http-sse'
	url: string
	headers?: Record<string, string>
	timeoutMs?: number
}

export type MCPTransportUnion = MCPStdioTransportConfig | MCPHttpSseTransportConfig

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
	annotations?: MCPToolAnnotations
}

export type MCPContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string }
	| { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }

export interface MCPToolResult {
	content: MCPContentBlock[]
	isError?: boolean
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
