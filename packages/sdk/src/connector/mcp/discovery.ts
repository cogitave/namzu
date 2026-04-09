import type { MCPDiscoveredTool } from '../../types/connector/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'
import { mcpToolToToolDefinition } from './adapter.js'
import type { MCPClient } from './client.js'

export class MCPToolDiscovery {
	private clients: MCPClient[]
	private log: Logger

	constructor(clients: MCPClient[]) {
		this.clients = clients
		this.log = getRootLogger().child({ component: 'MCPToolDiscovery' })
	}

	addClient(client: MCPClient): void {
		this.clients.push(client)
	}

	removeClient(clientId: string): void {
		this.clients = this.clients.filter((c) => c.id !== clientId)
	}

	async discoverAll(): Promise<MCPDiscoveredTool[]> {
		const results: MCPDiscoveredTool[] = []

		for (const client of this.clients) {
			if (!client.isConnected()) {
				this.log.warn(`Skipping disconnected MCP client: ${client.id}`)
				continue
			}

			try {
				const tools = await this.discoverFrom(client)
				results.push(...tools)
			} catch (err) {
				this.log.error(`Failed to discover tools from ${client.id}`, {
					error: toErrorMessage(err),
				})
			}
		}

		this.log.info(`Discovered ${results.length} MCP tools from ${this.clients.length} clients`)
		return results
	}

	async discoverFrom(client: MCPClient): Promise<MCPDiscoveredTool[]> {
		const state = client.getState()
		const tools = await client.listTools()

		return tools.map((tool) => ({
			tool,
			clientId: client.id,
			serverName: state.serverName,
		}))
	}

	async toToolDefinitions(): Promise<ToolDefinition[]> {
		const discovered = await this.discoverAll()
		return discovered.map((d) => {
			const client = this.clients.find((c) => c.id === d.clientId)
			if (!client) {
				throw new Error(`MCPClient not found for discovered tool: ${d.clientId}`)
			}
			return mcpToolToToolDefinition(d.tool, client, d.serverName)
		})
	}
}
