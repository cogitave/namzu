import type {
	MCPDiscoveredTool,
	MCPPromptDefinition,
	MCPToolDefinition,
} from '../../types/connector/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { mcpToolToToolDefinition } from './adapter.js'
import type { MCPClient } from './client.js'
import {
	type MCPToolDrift,
	type MCPToolPolicy,
	applyNamePolicy,
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
	/**
	 * Last admitted tool set per SERVER, for drift detection.
	 *
	 * Keyed by server name rather than client id, and the difference is the
	 * whole point. A client id is minted per connection, so on the path a
	 * real MCP server actually takes — a plugin enabling, connecting, and
	 * being disabled again — every discovery was the first one that id had
	 * ever seen, and drift could not fire however many times the server
	 * changed underneath. The threat is a server that advertises something
	 * benign when a host approves it and something else afterwards, which is
	 * a property of the SERVER across connections.
	 */
	private lastSeen = new Map<string, MCPToolDefinition[]>()

	constructor(clients: MCPClient[], options: MCPToolDiscoveryOptions = {}) {
		this.clients = clients
		this.options = options
		// Was `options.logger ?? getRootLogger().child(...)`: `??` binds looser
		// than the method call, so when `options.logger` WAS supplied the
		// `.child({component: ...})` binding never applied at all — a caller
		// that injected a logger got NO scope stamp, silently. `resolveLogger`
		// collapses the fallback so `.child()` always runs, for both paths.
		this.log = resolveLogger(options.logger).child({ component: 'MCPToolDiscovery' })
	}

	addClient(client: MCPClient): void {
		this.clients.push(client)
	}

	removeClient(clientId: string): void {
		this.clients = this.clients.filter((c) => c.id !== clientId)
		// The remembered tool set is deliberately NOT forgotten. Dropping it on
		// disconnect is what made the rug pull invisible: disable, swap the
		// server's tools, enable again, and the next discovery had nothing to
		// compare against. What is remembered is a name and a list of tool
		// shapes, so keeping it costs almost nothing.
	}

	async discoverAll(): Promise<MCPDiscoveredTool[]> {
		const results: MCPDiscoveredTool[] = []

		for (const client of this.clients) {
			if (!client.isConnected()) {
				this.log.warn('Skipping disconnected MCP client', { 'namzu.mcp.client_id': client.id })
				continue
			}

			try {
				const tools = await this.discoverFrom(client)
				results.push(...tools)
			} catch (err) {
				this.log.error('Failed to discover tools from an MCP client', {
					'namzu.mcp.client_id': client.id,
					error: toErrorMessage(err),
				})
			}
		}

		this.log.info('Discovered MCP tools', {
			'namzu.mcp.tool_count': results.length,
			'namzu.mcp.client_count': this.clients.length,
		})
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

	/**
	 * The prompts a server publishes, through the same admission gate its
	 * tools go through.
	 *
	 * A server publishing a prompt is the same trust question as one
	 * publishing a tool: the remote side must not decide what enters the
	 * agent's registry. Policy is matched on the prompt's own name, as the
	 * server reports it, before any namespacing.
	 *
	 * A server that does not implement prompts answers method-not-found;
	 * that is an ordinary answer, not a failure, so it yields none rather
	 * than taking discovery down.
	 */
	async discoverPromptsFrom(client: MCPClient): Promise<MCPPromptDefinition[]> {
		const state = client.getState()

		let advertised: MCPPromptDefinition[]
		try {
			advertised = await client.listPrompts()
		} catch (err) {
			this.log.debug('MCP server published no prompts', {
				serverName: state.serverName,
				clientId: client.id,
				reason: toErrorMessage(err),
			})
			return []
		}

		const policy = this.options.policies?.[state.serverName] ?? this.options.policies?.['*']
		const { admitted, refused } = applyNamePolicy(advertised, policy)

		if (refused.length > 0) {
			this.log.warn('MCP prompts refused by policy', {
				serverName: state.serverName,
				clientId: client.id,
				refused: refused.map((r) => `${r.name} (${r.reason})`),
			})
		}

		return admitted
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
		const previous = this.lastSeen.get(serverName)
		this.lastSeen.set(serverName, admitted)
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
