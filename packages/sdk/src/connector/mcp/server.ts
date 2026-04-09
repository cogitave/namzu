import type {
	MCPContentBlock,
	MCPJsonRpcMessage,
	MCPResource,
	MCPServerCapabilities,
	MCPServerConfig,
	MCPServerState,
	MCPToolDefinition,
	MCPToolResult,
	MCPTransport,
} from '../../types/connector/index.js'
import type { MCPServerId } from '../../types/ids/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateMCPServerId } from '../../utils/id.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

export interface MCPServerToolProvider {
	listTools(): MCPToolDefinition[]
	callTool(name: string, args?: Record<string, unknown>): Promise<MCPToolResult>
}

export interface MCPServerResourceProvider {
	listResources(): MCPResource[]
	readResource(uri: string): Promise<MCPContentBlock[]>
}

export class MCPServer {
	readonly id: MCPServerId
	private config: MCPServerConfig
	private toolProvider: MCPServerToolProvider
	private resourceProvider?: MCPServerResourceProvider
	private transport: MCPTransport | null = null
	private running = false
	private connectedClients = 0
	private startedAt?: number
	private log: Logger

	constructor(
		config: MCPServerConfig,
		toolProvider: MCPServerToolProvider,
		resourceProvider?: MCPServerResourceProvider,
	) {
		this.id = config.id ?? generateMCPServerId()
		this.config = config
		this.toolProvider = toolProvider
		this.resourceProvider = resourceProvider
		this.log = getRootLogger().child({ component: 'MCPServer', serverId: this.id })
	}

	async start(transport: MCPTransport): Promise<void> {
		if (this.running) {
			throw new Error(`MCPServer "${this.config.name}" is already running`)
		}

		this.transport = transport

		transport.onMessage((msg) => this.handleRequest(msg))
		transport.onClose(() => {
			this.connectedClients = Math.max(0, this.connectedClients - 1)
			this.log.info('MCP client disconnected')
		})
		transport.onError((err) => {
			this.log.error('MCP server transport error', { error: err.message })
		})

		await transport.connect()
		this.running = true
		this.startedAt = Date.now()
		this.log.info(`MCPServer "${this.config.name}" started`)
	}

	async stop(): Promise<void> {
		if (!this.running) return
		this.running = false
		if (this.transport) {
			await this.transport.close()
			this.transport = null
		}
		this.log.info(`MCPServer "${this.config.name}" stopped`)
	}

	isRunning(): boolean {
		return this.running
	}

	getState(): MCPServerState {
		return {
			id: this.id,
			name: this.config.name,
			running: this.running,
			connectedClients: this.connectedClients,
			startedAt: this.startedAt,
		}
	}

	private async handleRequest(message: MCPJsonRpcMessage): Promise<void> {
		if (message.id === undefined || !message.method) return

		try {
			const result = await this.dispatch(message.method, message.params ?? {})
			await this.respond(message.id, result)
		} catch (err) {
			await this.respondError(message.id, -32603, toErrorMessage(err))
		}
	}

	private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case 'initialize':
				return this.handleInitialize()
			case 'tools/list':
				return this.handleToolsList()
			case 'tools/call':
				return this.handleToolsCall(params)
			case 'resources/list':
				return this.handleResourcesList()
			case 'resources/read':
				return this.handleResourcesRead(params)
			case 'ping':
				return {}
			default:
				throw new Error(`Unknown method: ${method}`)
		}
	}

	private handleInitialize(): {
		protocolVersion: string
		capabilities: MCPServerCapabilities
		serverInfo: { name: string; version?: string }
	} {
		this.connectedClients++
		const capabilities: MCPServerCapabilities = {
			tools: { listChanged: false },
			...this.config.capabilities,
		}

		if (this.resourceProvider) {
			capabilities.resources = { subscribe: false, listChanged: false }
		}

		return {
			protocolVersion: '2024-11-05',
			capabilities,
			serverInfo: {
				name: this.config.name,
				version: this.config.version,
			},
		}
	}

	private handleToolsList(): { tools: MCPToolDefinition[] } {
		return { tools: this.toolProvider.listTools() }
	}

	private async handleToolsCall(params: Record<string, unknown>): Promise<MCPToolResult> {
		const name = params.name as string
		const args = (params.arguments ?? {}) as Record<string, unknown>

		if (!name) {
			return {
				content: [{ type: 'text', text: 'Missing tool name' }],
				isError: true,
			}
		}

		return this.toolProvider.callTool(name, args)
	}

	private handleResourcesList(): { resources: MCPResource[] } {
		if (!this.resourceProvider) {
			return { resources: [] }
		}
		return { resources: this.resourceProvider.listResources() }
	}

	private async handleResourcesRead(
		params: Record<string, unknown>,
	): Promise<{ contents: MCPContentBlock[] }> {
		const uri = params.uri as string
		if (!uri) {
			throw new Error('Missing resource URI')
		}
		if (!this.resourceProvider) {
			throw new Error('Resource provider not configured')
		}
		return { contents: await this.resourceProvider.readResource(uri) }
	}

	private async respond(id: string | number, result: unknown): Promise<void> {
		if (!this.transport) return
		await this.transport.send({
			jsonrpc: '2.0',
			id,
			result,
		})
	}

	private async respondError(id: string | number, code: number, message: string): Promise<void> {
		if (!this.transport) return
		await this.transport.send({
			jsonrpc: '2.0',
			id,
			error: { code, message },
		})
	}
}
