import type { ConnectorManager } from '../../manager/connector/lifecycle.js'
import type { ToolDefinition, ToolRegistryContract } from '../../types/tool/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { connectorInstanceToTools, createConnectorRouterTool } from './adapter.js'

export type ConnectorToolStrategy = 'per-method' | 'router'

export interface ConnectorToolRouterConfig {
	manager: ConnectorManager
	strategy?: ConnectorToolStrategy
	log?: Logger
}

export class ConnectorToolRouter {
	private manager: ConnectorManager
	private strategy: ConnectorToolStrategy
	private log: Logger

	constructor(config: ConnectorToolRouterConfig) {
		this.manager = config.manager
		this.strategy = config.strategy ?? 'per-method'
		this.log = resolveLogger(config.log).child({ component: 'ConnectorToolRouter' })
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
				this.log.error('Failed to create tools for a connector instance', {
					'namzu.connector.instance_id': instance.id,
					'exception.message': toErrorMessage(err),
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
		this.log.info('Registered connector tools', {
			'namzu.connector.tool_count': names.length,
			'namzu.tool.names': names,
		})
		return names
	}

	unregisterTools(toolRegistry: ToolRegistryContract, toolNames: string[]): void {
		for (const name of toolNames) {
			toolRegistry.unregister(name)
		}
		this.log.info('Unregistered connector tools', {
			'namzu.connector.tool_count': toolNames.length,
		})
	}

	refreshTools(toolRegistry: ToolRegistryContract, previousNames: string[]): string[] {
		this.unregisterTools(toolRegistry, previousNames)
		return this.registerTools(toolRegistry)
	}
}
