import type { ConnectorManager } from '../../manager/connector/lifecycle.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { connectorInstanceToTools, createConnectorRouterTool } from './adapter.js'

export type ConnectorToolStrategy = 'per-method' | 'router'

export interface ConnectorTools {
	strategy?: ConnectorToolStrategy
	log?: Logger
}

/**
 * Every tool a connector manager's connected instances currently offer.
 *
 * Plain and stateless — a caller wraps the result in `toolset(source, tools)`
 * (`toolsets/toolset.ts`) itself, re-calling this whenever a reconnect or a
 * drift notice (`onMCPToolDrift`-shaped) means the set may have changed. This
 * replaces `ConnectorToolRouter`, whose `registerTools`/`unregisterTools`/
 * `refreshTools` mutated a `ToolRegistryContract` directly (plan.md v3 §2)
 * and had no production caller; a live toolset with its own `onChange` is
 * where that live-refresh story belongs now, not a router bound to a
 * specific registry instance.
 */
export function connectorTools(
	manager: ConnectorManager,
	config: ConnectorTools = {},
): ToolDefinition[] {
	const strategy = config.strategy ?? 'per-method'
	const log = resolveLogger(config.log).child({ [SCOPE_ATTRIBUTE]: 'connector/tools/router' })

	if (strategy === 'router') {
		const connected = manager.listConnectedInstances()
		if (connected.length === 0) return []
		return [createConnectorRouterTool(manager)]
	}

	const tools: ToolDefinition[] = []
	for (const instance of manager.listConnectedInstances()) {
		try {
			tools.push(...connectorInstanceToTools(instance.id, manager))
		} catch (err) {
			log.error('Failed to create tools for a connector instance', {
				'namzu.connector.instance_id': instance.id,
				'exception.message': toErrorMessage(err),
			})
		}
	}
	return tools
}
