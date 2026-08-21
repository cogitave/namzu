import { connectorToolError } from '../../../connector/tools/result.js'
import type { ConnectorManager } from '../../../manager/connector/lifecycle.js'
import { renderToolSchema } from '../../../registry/tool/schema.js'
import type {
	ConnectorDefinition,
	ConnectorExecuteResult,
	ConnectorInstance,
	ConnectorMethod,
	ConnectorOperationOptions,
	MCPConnectorBridgeToolMapping,
	MCPJsonSchema,
	MCPToolDefinition,
	MCPToolResult,
	MCPValueJsonSchema,
} from '../../../types/connector/index.js'
import type { ConnectorId, ConnectorInstanceId } from '../../../types/ids/index.js'
import { SCOPE_ATTRIBUTE } from '../../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../../utils/logger.js'

export class MCPConnectorBridge {
	private manager: ConnectorManager
	private prefix: string
	private mappings: MCPConnectorBridgeToolMapping[] = []
	private log: Logger

	constructor(config: { manager: ConnectorManager; prefix?: string; log?: Logger }) {
		this.manager = config.manager
		this.prefix = config.prefix ?? 'namzu'
		this.log = resolveLogger(config.log).child({ [SCOPE_ATTRIBUTE]: 'bridge/mcp/connector' })
	}

	listTools(instanceId?: ConnectorInstanceId): MCPToolDefinition[] {
		const instances = instanceId
			? ([this.manager.getInstance(instanceId)].filter(Boolean) as ConnectorInstance[])
			: this.manager.listConnectedInstances()

		this.mappings = []
		const tools: MCPToolDefinition[] = []

		for (const instance of instances) {
			const connectorId = this.manager.getInstanceConnectorId(instance.id)
			const definition = this.manager.getInstanceDefinition(instance.id)

			for (const method of definition.methods) {
				const mcpTool = this.methodToMCPTool(instance.id, connectorId, definition, method)
				tools.push(mcpTool)
			}
		}

		this.log.info('Bridge generated MCP tools', {
			'namzu.mcp.tool_count': tools.length,
			'namzu.connector.instance_count': instances.length,
		})
		return tools
	}

	async callTool(
		name: string,
		args?: Record<string, unknown>,
		options?: ConnectorOperationOptions,
	): Promise<MCPToolResult> {
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
			signal: options?.signal,
		})

		return this.connectorResultToMCPResult(result)
	}

	getMappings(): MCPConnectorBridgeToolMapping[] {
		return [...this.mappings]
	}

	private methodToMCPTool(
		instanceId: ConnectorInstanceId,
		connectorId: ConnectorId,
		definition: ConnectorDefinition,
		method: ConnectorMethod,
	): MCPToolDefinition {
		const mcpToolName = `${this.prefix}_${connectorId}_${method.name}`

		this.mappings.push({
			mcpToolName,
			connectorId,
			instanceId,
			methodName: method.name,
		})

		const inputSchema = this.zodToMCPSchema(method)

		return {
			name: mcpToolName,
			description: `[${definition.name}] ${method.description}`,
			inputSchema,
			...(method.outputSchema ? { outputSchema: this.zodToMCPOutputSchema(method) } : {}),
		}
	}

	private zodToMCPSchema(method: ConnectorMethod): MCPJsonSchema {
		return renderToolSchema(method.inputSchema) as MCPJsonSchema
	}

	private zodToMCPOutputSchema(method: ConnectorMethod): MCPValueJsonSchema {
		return renderToolSchema(
			method.outputSchema as NonNullable<ConnectorMethod['outputSchema']>,
		) as MCPValueJsonSchema
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
			content: [{ type: 'text', text: connectorToolError(result) }],
			isError: true,
		}
	}
}
