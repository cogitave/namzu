import type {
	MCPClientConfig,
	MCPClientState,
	MCPConnectionStatus,
	MCPContentBlock,
	MCPInitializeResult,
	MCPJsonRpcMessage,
	MCPResource,
	MCPResourceTemplate,
	MCPServerCapabilities,
	MCPToolDefinition,
	MCPToolResult,
	MCPTransport,
	MCPTransportUnion,
} from '../../types/connector/index.js'
import type { MCPClientId } from '../../types/ids/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateMCPClientId } from '../../utils/id.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'
import { HttpSseTransport } from './http-sse.js'
import { StdioTransport } from './stdio.js'

const MCP_PROTOCOL_VERSION = '2024-11-05'
const NAMZU_CLIENT_INFO = { name: 'namzu-sdk', version: '0.1.0' }

export class MCPClient {
	readonly id: MCPClientId
	private transport: MCPTransport
	private status: MCPConnectionStatus = 'disconnected'
	private serverInfo?: { name: string; version?: string }
	private serverCapabilities?: MCPServerCapabilities
	private connectedAt?: number
	private error?: string
	private pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void
			reject: (reason: Error) => void
		}
	>()
	private nextRequestId = 1
	private notificationHandlers: Array<(method: string, params?: Record<string, unknown>) => void> =
		[]
	private log: Logger
	private readonly config: MCPClientConfig

	constructor(config: MCPClientConfig) {
		this.config = config
		this.id = config.id ?? generateMCPClientId()
		this.transport = this.createTransport(config.transport)
		this.log = getRootLogger().child({ component: 'MCPClient', serverId: config.serverName })
	}

	async connect(): Promise<MCPInitializeResult> {
		if (this.status === 'connected') {
			throw new Error(`MCPClient already connected to "${this.config.serverName}"`)
		}

		this.status = 'connecting'

		try {
			this.transport.onMessage((msg) => this.handleMessage(msg))
			this.transport.onClose(() => {
				this.status = 'disconnected'
				this.log.info('MCP transport closed')
			})
			this.transport.onError((err) => {
				this.status = 'error'
				this.error = err.message
				this.log.error('MCP transport error', { error: err.message })
			})

			await this.transport.connect()

			const result = (await this.request('initialize', {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: this.config.capabilities ?? {},
				clientInfo: this.config.clientInfo ?? NAMZU_CLIENT_INFO,
			})) as MCPInitializeResult

			this.serverInfo = result.serverInfo
			this.serverCapabilities = result.capabilities

			await this.notify('notifications/initialized', {})

			this.status = 'connected'
			this.connectedAt = Date.now()
			this.log.info(`Connected to MCP server: ${result.serverInfo.name}`)

			return result
		} catch (err) {
			this.status = 'error'
			this.error = toErrorMessage(err)
			this.log.error('MCP connection failed', { error: this.error })
			throw err
		}
	}

	async disconnect(): Promise<void> {
		if (this.status === 'disconnected') return

		for (const [, pending] of this.pendingRequests) {
			pending.reject(new Error('MCPClient disconnecting'))
		}
		this.pendingRequests.clear()

		await this.transport.close()
		this.status = 'disconnected'
		this.connectedAt = undefined
		this.log.info('MCP client disconnected')
	}

	isConnected(): boolean {
		return this.status === 'connected'
	}

	getState(): MCPClientState {
		return {
			id: this.id,
			serverName: this.config.serverName,
			status: this.status,
			serverInfo: this.serverInfo,
			serverCapabilities: this.serverCapabilities,
			connectedAt: this.connectedAt,
			error: this.error,
		}
	}

	async listTools(): Promise<MCPToolDefinition[]> {
		this.requireConnected()
		const result = (await this.request('tools/list', {})) as { tools: MCPToolDefinition[] }
		return result.tools
	}

	async callTool(name: string, args?: Record<string, unknown>): Promise<MCPToolResult> {
		this.requireConnected()
		const result = (await this.request('tools/call', {
			name,
			arguments: args ?? {},
		})) as MCPToolResult
		return result
	}

	async listResources(): Promise<MCPResource[]> {
		this.requireConnected()
		const result = (await this.request('resources/list', {})) as { resources: MCPResource[] }
		return result.resources
	}

	async readResource(uri: string): Promise<MCPContentBlock[]> {
		this.requireConnected()
		const result = (await this.request('resources/read', { uri })) as {
			contents: MCPContentBlock[]
		}
		return result.contents
	}

	async listResourceTemplates(): Promise<MCPResourceTemplate[]> {
		this.requireConnected()
		const result = (await this.request('resources/templates/list', {})) as {
			resourceTemplates: MCPResourceTemplate[]
		}
		return result.resourceTemplates
	}

	onNotification(handler: (method: string, params?: Record<string, unknown>) => void): void {
		this.notificationHandlers.push(handler)
	}

	private createTransport(config: MCPTransportUnion): MCPTransport {
		switch (config.type) {
			case 'stdio':
				return new StdioTransport(config)
			case 'http-sse':
				return new HttpSseTransport(config)
			default:
				throw new Error(`Unsupported MCP transport type: ${(config as MCPTransportUnion).type}`)
		}
	}

	private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = this.nextRequestId++
		const message: MCPJsonRpcMessage = {
			jsonrpc: '2.0',
			id,
			method,
			params,
		}

		return new Promise<unknown>((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject })
			this.transport.send(message).catch((err) => {
				this.pendingRequests.delete(id)
				reject(err)
			})
		})
	}

	private async notify(method: string, params: Record<string, unknown>): Promise<void> {
		const message: MCPJsonRpcMessage = {
			jsonrpc: '2.0',
			method,
			params,
		}
		await this.transport.send(message)
	}

	private handleMessage(message: MCPJsonRpcMessage): void {
		if (message.id !== undefined) {
			const pending = this.pendingRequests.get(message.id)
			if (pending) {
				this.pendingRequests.delete(message.id)
				if (message.error) {
					pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`))
				} else {
					pending.resolve(message.result)
				}
				return
			}
		}

		if (message.method && message.id === undefined) {
			for (const handler of this.notificationHandlers) {
				handler(message.method, message.params)
			}
		}
	}

	private requireConnected(): void {
		if (this.status !== 'connected') {
			throw new Error(
				`MCPClient "${this.config.serverName}" is not connected (status: ${this.status})`,
			)
		}
	}
}
