import { JSON_RPC_METHOD_NOT_FOUND } from '../../../constants/mcp/index.js'
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
} from '../../../types/connector/index.js'
import type { MCPPromptDefinition, MCPPromptMessage } from '../../../types/connector/index.js'
import type { MCPServerId } from '../../../types/ids/index.js'
import { toErrorMessage } from '../../../utils/error.js'
import { generateMCPServerId } from '../../../utils/id.js'
import { type Logger, resolveLogger } from '../../../utils/logger.js'

/**
 * A method this server does not implement.
 *
 * Carried as its own error so the dispatcher can answer with the protocol's
 * own code instead of a generic internal error. `-32603` tells a client the
 * server broke; `-32601` tells it the server does not do this — and only the
 * second lets a client stop asking rather than retry.
 */
export class MCPMethodNotFound extends Error {
	constructor(readonly method: string) {
		super(`Method not found: ${method}`)
		this.name = 'MCPMethodNotFound'
	}
}

export interface MCPServerToolProvider {
	listTools(): MCPToolDefinition[]
	callTool(name: string, args?: Record<string, unknown>): Promise<MCPToolResult>
}

export interface MCPServerResourceProvider {
	listResources(): MCPResource[]
	readResource(uri: string): Promise<MCPContentBlock[]>
}

/**
 * Prompts this server publishes.
 *
 * Injected as an interface like the other two, so the server owns dispatch
 * and the host owns content. `MCPPromptDefinition` existed in the types
 * from the start with no way to serve one.
 */
export interface MCPServerPromptProvider {
	listPrompts(): MCPPromptDefinition[]
	getPrompt(
		name: string,
		args?: Record<string, string>,
	): Promise<{ description?: string; messages: MCPPromptMessage[] }>
}

export class MCPServer {
	readonly id: MCPServerId
	private config: MCPServerConfig
	private toolProvider: MCPServerToolProvider
	private resourceProvider?: MCPServerResourceProvider
	private promptProvider?: MCPServerPromptProvider
	private transport: MCPTransport | null = null
	private running = false
	private connectedClients = 0
	private startedAt?: number
	private log: Logger

	constructor(
		config: MCPServerConfig,
		toolProvider: MCPServerToolProvider,
		resourceProvider?: MCPServerResourceProvider,
		promptProvider?: MCPServerPromptProvider,
		log?: Logger,
	) {
		this.id = config.id ?? generateMCPServerId()
		this.config = config
		this.toolProvider = toolProvider
		this.resourceProvider = resourceProvider
		this.promptProvider = promptProvider
		this.log = resolveLogger(log).child({ component: 'MCPServer', serverId: this.id })
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
			const code = err instanceof MCPMethodNotFound ? JSON_RPC_METHOD_NOT_FOUND : -32603
			await this.respondError(message.id, code, toErrorMessage(err))
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
			case 'prompts/list':
				return this.handlePromptsList()
			case 'prompts/get':
				return this.handlePromptsGet(params)
			case 'ping':
				return {}
			default:
				throw new MCPMethodNotFound(method)
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

		// Declared only when there is something behind it, matching resources
		// above. A capability advertised without a provider is a promise the
		// next call breaks.
		if (this.promptProvider) {
			capabilities.prompts = { listChanged: false }
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

	/**
	 * An empty list is what a server with NO resources returns. A server
	 * that cannot serve resources at all has to say so differently.
	 *
	 * This used to answer `{ resources: [] }` when no provider was
	 * configured, for a capability `initialize` never advertised — so a
	 * client that asked anyway was told, in the protocol's own vocabulary,
	 * that the answer is "none" rather than "not here". The two send a
	 * client in opposite directions: one stops asking, the other looks for
	 * the resource somewhere else.
	 */
	private handleResourcesList(): { resources: MCPResource[] } {
		if (!this.resourceProvider) {
			throw new MCPMethodNotFound('resources/list')
		}
		return { resources: this.resourceProvider.listResources() }
	}

	private handlePromptsList(): { prompts: MCPPromptDefinition[] } {
		if (!this.promptProvider) {
			throw new MCPMethodNotFound('prompts/list')
		}
		return { prompts: this.promptProvider.listPrompts() }
	}

	private async handlePromptsGet(
		params: Record<string, unknown>,
	): Promise<{ description?: string; messages: MCPPromptMessage[] }> {
		if (!this.promptProvider) {
			throw new MCPMethodNotFound('prompts/get')
		}
		const name = params.name as string
		if (!name) {
			throw new Error('prompts/get requires a "name"')
		}
		const args = (params.arguments as Record<string, string> | undefined) ?? {}

		// Required arguments are checked HERE rather than left to the
		// provider. A prompt declares them, so a missing one is answerable
		// from the declaration alone, and every provider would otherwise
		// re-implement the same check or forget to.
		const declared = this.promptProvider.listPrompts().find((p) => p.name === name)
		if (!declared) {
			throw new Error(`Unknown prompt: ${name}`)
		}
		const missing = (declared.arguments ?? [])
			.filter((a) => a.required === true)
			.map((a) => a.name)
			.filter((n) => args[n] === undefined)
		if (missing.length > 0) {
			throw new Error(
				`prompts/get "${name}" is missing required argument(s): ${missing.join(', ')}`,
			)
		}

		return this.promptProvider.getPrompt(name, args)
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
