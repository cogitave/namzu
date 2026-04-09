import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ConnectorManager } from '../../../manager/connector/lifecycle.js'
import type {
	ConnectorDefinition,
	ConnectorExecuteResult,
	ConnectorInstance,
	ConnectorMethod,
	MCPConnectorBridgeToolMapping,
	MCPJsonSchema,
	MCPToolDefinition,
	MCPToolResult,
} from '../../../types/connector/index.js'
import type { ConnectorInstanceId } from '../../../types/ids/index.js'
import { type Logger, getRootLogger } from '../../../utils/logger.js'

export class MCPConnectorBridge {
	private manager: ConnectorManager
	private prefix: string
	private mappings: MCPConnectorBridgeToolMapping[] = []
	private log: Logger

	constructor(config: { manager: ConnectorManager; prefix?: string }) {
		this.manager = config.manager
		this.prefix = config.prefix ?? 'namzu'
		this.log = getRootLogger().child({ component: 'MCPConnectorBridge' })
	}

	listTools(instanceId?: ConnectorInstanceId): MCPToolDefinition[] {
		const instances = instanceId
			? ([this.manager.getInstance(instanceId)].filter(Boolean) as ConnectorInstance[])
			: this.manager.listConnectedInstances()

		this.mappings = []
		const tools: MCPToolDefinition[] = []

		for (const instance of instances) {
			const definition = this.manager.getRegistry().get(instance.connectorId)
			if (!definition) continue

			for (const method of definition.methods) {
				const mcpTool = this.methodToMCPTool(instance, definition, method)
				tools.push(mcpTool)
			}
		}

		this.log.info(`Bridge generated ${tools.length} MCP tools from ${instances.length} instances`)
		return tools
	}

	async callTool(name: string, args?: Record<string, unknown>): Promise<MCPToolResult> {
		const mapping = this.mappings.find((m) => m.mcpToolName === name)
		if (!mapping) {
			return {
				content: [{ type: 'text', text: `Unknown tool: "${name}"` }],
				isError: true,
			}
		}

		const result = await this.manager.execute({
			instanceId: mapping.instanceId,
			method: mapping.methodName,
			input: args ?? {},
		})

		return this.connectorResultToMCPResult(result)
	}

	getMappings(): MCPConnectorBridgeToolMapping[] {
		return [...this.mappings]
	}

	private methodToMCPTool(
		instance: ConnectorInstance,
		definition: ConnectorDefinition,
		method: ConnectorMethod,
	): MCPToolDefinition {
		const mcpToolName = `${this.prefix}_${instance.connectorId}_${method.name}`

		this.mappings.push({
			mcpToolName,
			connectorId: instance.connectorId,
			instanceId: instance.id,
			methodName: method.name,
		})

		const inputSchema = this.zodToMCPSchema(method)

		return {
			name: mcpToolName,
			description: `[${definition.name}] ${method.description}`,
			inputSchema,
		}
	}

	private zodToMCPSchema(method: ConnectorMethod): MCPJsonSchema {
		try {
			const jsonSchema = zodToJsonSchema(method.inputSchema, { target: 'openApi3' })
			return {
				type: 'object',
				...jsonSchema,
			} as MCPJsonSchema
		} catch {
			return { type: 'object' }
		}
	}

	private connectorResultToMCPResult(result: ConnectorExecuteResult): MCPToolResult {
		if (result.success) {
			const text =
				typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)
			return {
				content: [{ type: 'text', text }],
				isError: false,
			}
		}

		return {
			content: [{ type: 'text', text: result.error ?? 'Unknown error' }],
			isError: true,
		}
	}
}
