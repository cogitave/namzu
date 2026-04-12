import type { ConnectorManager } from '../../../manager/connector/lifecycle.js'
import type { ToolDefinition, ToolRegistryContract } from '../../../types/tool/index.js'
import { toErrorMessage } from '../../../utils/error.js'
import { type Logger, getRootLogger } from '../../../utils/logger.js'
import { connectorInstanceToTools, createConnectorRouterTool } from './adapter.js'

export type ConnectorToolStrategy = 'per-method' | 'router'

export interface ConnectorToolRouterConfig {
	manager: ConnectorManager
	strategy?: ConnectorToolStrategy
}

export class ConnectorToolRouter {
	private manager: ConnectorManager
	private strategy: ConnectorToolStrategy
	private log: Logger

	constructor(config: ConnectorToolRouterConfig) {
		this.manager = config.manager
		this.strategy = config.strategy ?? 'per-method'
		this.log = getRootLogger().child({ component: 'ConnectorToolRouter' })
	}

	getTools(): ToolDefinition[] {
		if (this.strategy === 'router') {
			const connected = this.manager.listConnectedInstances()
			if (connected.length === 0) return []
			return [createConnectorRouterTool(this.manager)]
		}

		const tools: ToolDefinition[] = []
		for (const instance of this.manager.listConnectedInstances()) {
			try {
				tools.push(...connectorInstanceToTools(instance.id, this.manager))
			} catch (err) {
				this.log.error(`Failed to create tools for instance ${instance.id}`, {
					error: toErrorMessage(err),
				})
			}
		}
		return tools
	}

	registerTools(toolRegistry: ToolRegistryContract): string[] {
		const tools = this.getTools()
		const names: string[] = []
		for (const tool of tools) {
			toolRegistry.register(tool)
			names.push(tool.name)
		}
		this.log.info(`Registered ${names.length} connector tools`, { tools: names })
		return names
	}

	unregisterTools(toolRegistry: ToolRegistryContract, toolNames: string[]): void {
		for (const name of toolNames) {
			toolRegistry.unregister(name)
		}
		this.log.info(`Unregistered ${toolNames.length} connector tools`)
	}

	refreshTools(toolRegistry: ToolRegistryContract, previousNames: string[]): string[] {
		this.unregisterTools(toolRegistry, previousNames)
		return this.registerTools(toolRegistry)
	}
}
