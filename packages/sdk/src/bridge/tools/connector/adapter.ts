import { z } from 'zod'
import type { ConnectorManager } from '../../../manager/connector/lifecycle.js'
import type { ConnectorMethod } from '../../../types/connector/index.js'
import type { ConnectorId, ConnectorInstanceId } from '../../../types/ids/index.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../../../types/tool/index.js'
import { parseConnectorInstanceId } from '../../../utils/id.js'

export function connectorMethodToTool(
	connectorId: ConnectorId,
	instanceId: ConnectorInstanceId,
	method: ConnectorMethod,
	manager: ConnectorManager,
): ToolDefinition {
	const toolName = `${connectorId}_${method.name}`

	return {
		name: toolName,
		description: `[${connectorId}] ${method.description}`,
		inputSchema: method.inputSchema,
		category: 'network',
		permissions: ['network_access'],
		isReadOnly: () => false,
		isDestructive: () => false,
		isConcurrencySafe: () => true,

		async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
			const result = await manager.execute({
				instanceId,
				method: method.name,
				input,
			})

			return {
				success: result.success,
				output: result.success ? JSON.stringify(result.output, null, 2) : '',
				data: result.output,
				error: result.error,
			}
		},
	}
}

export function connectorInstanceToTools(
	instanceId: ConnectorInstanceId,
	manager: ConnectorManager,
): ToolDefinition[] {
	const instance = manager.getInstance(instanceId)
	if (!instance) {
		throw new Error(`Connector instance not found: "${instanceId}"`)
	}

	const definition = manager.getRegistry().getOrThrow(instance.connectorId)
	return definition.methods.map((method) =>
		connectorMethodToTool(instance.connectorId, instanceId, method, manager),
	)
}

export function allConnectorTools(manager: ConnectorManager): ToolDefinition[] {
	const tools: ToolDefinition[] = []
	for (const instance of manager.listConnectedInstances()) {
		tools.push(...connectorInstanceToTools(instance.id, manager))
	}
	return tools
}

const ConnectorRouterInputSchema = z.object({
	connectorId: z
		.string()
		.describe('The connector definition ID (e.g., "conn_http", "conn_webhook")'),
	instanceId: z.string().describe('The connector instance ID (e.g., "ci_abc123")'),
	method: z.string().describe('The method to execute on the connector'),
	input: z.record(z.unknown()).describe('The input data for the method'),
})

export type ConnectorRouterInput = z.infer<typeof ConnectorRouterInputSchema>

export function createConnectorRouterTool(
	manager: ConnectorManager,
): ToolDefinition<ConnectorRouterInput> {
	return {
		name: 'connector_execute',
		description: buildRouterDescription(manager),
		inputSchema: ConnectorRouterInputSchema,
		category: 'network',
		permissions: ['network_access'],
		isReadOnly: () => false,
		isDestructive: () => false,
		isConcurrencySafe: () => true,

		async execute(input: ConnectorRouterInput, _context: ToolContext): Promise<ToolResult> {
			const instanceId = parseConnectorInstanceId(String(input.instanceId))
			const instance = manager.getInstance(instanceId)
			if (!instance) {
				return {
					success: false,
					output: '',
					error: `Connector instance not found: "${input.instanceId}"`,
				}
			}

			if (instance.connectorId !== input.connectorId) {
				return {
					success: false,
					output: '',
					error: `Instance "${input.instanceId}" belongs to connector "${instance.connectorId}", not "${input.connectorId}"`,
				}
			}

			const result = await manager.execute({
				instanceId,
				method: input.method,
				input: input.input,
			})

			return {
				success: result.success,
				output: result.success ? JSON.stringify(result.output, null, 2) : '',
				data: result.output,
				error: result.error,
			}
		},
	}
}

function buildRouterDescription(manager: ConnectorManager): string {
	const instances = manager.listConnectedInstances()
	if (instances.length === 0) {
		return 'Execute a method on a connected connector instance. No connectors are currently connected.'
	}

	const parts = ['Execute a method on a connected connector instance. Available:']
	for (const inst of instances) {
		const def = manager.getRegistry().get(inst.connectorId)
		if (def) {
			const methods = def.methods.map((m) => m.name).join(', ')
			parts.push(`- ${inst.connectorId} (${inst.id}): ${methods}`)
		}
	}
	return parts.join('\n')
}
