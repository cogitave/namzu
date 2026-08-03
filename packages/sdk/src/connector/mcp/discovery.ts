import type { MCPDiscoveredTool, MCPToolDefinition } from '../../types/connector/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'
import { mcpToolToToolDefinition } from './adapter.js'
import type { MCPClient } from './client.js'
import {
	type MCPToolDrift,
	type MCPToolPolicy,
	applyToolPolicy,
	diffTools,
	hasDrift,
} from './policy.js'

export interface MCPToolDiscoveryOptions {
	/**
	 * What each server is allowed to contribute, keyed by server name.
	 * `'*'` applies to every server not named explicitly.
	 *
	 * Absent ⇒ everything is admitted, which is the pre-existing behavior
	 * and the reason this option exists.
	 */
	readonly policies?: Readonly<Record<string, MCPToolPolicy>>
	/**
	 * Called when a server's tool set differs from the previous discovery.
	 *
	 * Drift is reported rather than blocked because the right response is a
	 * host decision: a dev server legitimately changes between runs, while
	 * a production one changing mid-session is the "rug pull" — advertise
	 * something benign at approval time, swap it afterwards. Only the host
	 * knows which it is looking at.
	 */
	readonly onDrift?: (event: { serverName: string; clientId: string; drift: MCPToolDrift }) => void
	readonly logger?: Logger
}

export class MCPToolDiscovery {
	private clients: MCPClient[]
	private log: Logger
	private options: MCPToolDiscoveryOptions
	/** Last admitted tool set per client, for drift detection. */
	private lastSeen = new Map<string, MCPToolDefinition[]>()

	constructor(clients: MCPClient[], options: MCPToolDiscoveryOptions = {}) {
		this.clients = clients
		this.options = options
		this.log = options.logger ?? getRootLogger().child({ component: 'MCPToolDiscovery' })
	}

	addClient(client: MCPClient): void {
		this.clients.push(client)
	}

	removeClient(clientId: string): void {
		this.clients = this.clients.filter((c) => c.id !== clientId)
		this.lastSeen.delete(clientId)
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
		const advertised = await client.listTools()

		// The boundary. Without it the REMOTE side decides what enters the
		// agent's registry, which inverts least privilege: a server could
		// add a tool between two runs and it became callable with nobody
		// having agreed to it.
		const policy = this.options.policies?.[state.serverName] ?? this.options.policies?.['*']
		const { admitted, refused } = applyToolPolicy(advertised, policy)

		if (refused.length > 0) {
			this.log.warn('MCP tools refused by policy', {
				serverName: state.serverName,
				clientId: client.id,
				refused: refused.map((r) => `${r.name} (${r.reason})`),
			})
		}

		this.detectDrift(client.id, state.serverName, admitted)

		return admitted.map((tool) => ({
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

	private detectDrift(clientId: string, serverName: string, admitted: MCPToolDefinition[]): void {
		const previous = this.lastSeen.get(clientId)
		this.lastSeen.set(clientId, admitted)
		if (!previous) return

		const drift = diffTools(previous, admitted)
		if (!hasDrift(drift)) return

		this.log.warn('MCP server tool set changed since the last discovery', {
			serverName,
			clientId,
			added: drift.added,
			removed: drift.removed,
			changed: drift.changed,
		})
		this.options.onDrift?.({ serverName, clientId, drift })
	}
}
