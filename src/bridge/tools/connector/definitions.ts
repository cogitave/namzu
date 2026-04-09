import { z } from 'zod'
import type { ConnectorManager } from '../../../manager/connector/lifecycle.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { parseConnectorInstanceId } from '../../../utils/id.js'

export interface ConnectorToolConfig {
	manager: ConnectorManager
}

const connectorExecuteInputSchema = z.object({
	instance_id: z.string().describe('The connector instance ID to execute against'),
	method: z.string().describe('The connector method to invoke (e.g. "request", "send")'),
	input: z.record(z.unknown()).describe('Input parameters for the connector method'),
})

const connectorListInputSchema = z.object({})

export function createConnectorExecuteTool(config: ConnectorToolConfig): ToolDefinition {
	return defineTool({
		name: 'connector_execute',
		description:
			'Execute a method on a connected external service. Use this to make HTTP requests, send webhooks, or interact with any configured connector.',
		inputSchema: connectorExecuteInputSchema,
		category: 'network',
		permissions: ['network_access'],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,

		async execute(input) {
			const instanceId = parseConnectorInstanceId(String(input.instance_id))
			const instance = config.manager.getInstance(instanceId)

			if (!instance) {
				return {
					success: false,
					output: '',
					error: `Connector instance not found: "${instanceId}"`,
				}
			}

			if (instance.status !== 'connected') {
				return {
					success: false,
					output: '',
					error: `Connector "${instanceId}" is not connected (status: ${instance.status})`,
				}
			}

			const result = await config.manager.execute({
				instanceId,
				method: input.method,
				input: input.input,
			})

			if (!result.success) {
				return {
					success: false,
					output: '',
					error: result.error ?? 'Connector execution failed',
				}
			}

			const outputStr =
				typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)

			return {
				success: true,
				output: outputStr,
				data: {
					durationMs: result.durationMs,
					metadata: result.metadata,
				},
			}
		},
	})
}

export function createConnectorListTool(config: ConnectorToolConfig): ToolDefinition {
	return defineTool({
		name: 'connector_list',
		description: 'List all available connector instances and their connection status.',
		inputSchema: connectorListInputSchema,
		category: 'network',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,

		async execute() {
			const instances = config.manager.listInstances()

			if (instances.length === 0) {
				return {
					success: true,
					output: 'No connector instances configured.',
				}
			}

			const lines = instances.map(
				(i) => `- ${i.id} (${i.connectorId}): ${i.config.name} [${i.status}]`,
			)

			return {
				success: true,
				output: lines.join('\n'),
				data: {
					instances: instances.map((i) => ({
						id: i.id,
						connectorId: i.connectorId,
						name: i.config.name,
						status: i.status,
					})),
				},
			}
		},
	})
}

export function createConnectorTools(config: ConnectorToolConfig): ToolDefinition[] {
	return [createConnectorExecuteTool(config), createConnectorListTool(config)]
}
