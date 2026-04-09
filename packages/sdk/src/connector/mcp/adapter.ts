import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type {
	MCPJsonSchema,
	MCPToolDefinition,
	MCPToolResult,
} from '../../types/connector/index.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../../types/tool/index.js'
import type { MCPClient } from './client.js'

export function mcpJsonSchemaToZod(schema: MCPJsonSchema): z.ZodType {
	if (!schema.properties || Object.keys(schema.properties).length === 0) {
		return z.object({}).passthrough()
	}

	const shape: Record<string, z.ZodType> = {}
	const required = new Set(schema.required ?? [])

	for (const [key, propSchema] of Object.entries(schema.properties)) {
		let field = jsonSchemaPropertyToZod(propSchema)
		if (!required.has(key)) {
			field = field.optional()
		}
		shape[key] = field
	}

	return z.object(shape).passthrough()
}

function jsonSchemaPropertyToZod(prop: unknown): z.ZodType {
	if (typeof prop !== 'object' || prop === null) return z.unknown()
	const schema = prop as Record<string, unknown>

	switch (schema.type) {
		case 'string':
			return z.string()
		case 'number':
		case 'integer':
			return z.number()
		case 'boolean':
			return z.boolean()
		case 'array':
			return z.array(z.unknown())
		case 'object':
			return z.record(z.unknown())
		default:
			return z.unknown()
	}
}

export function zodToMCPJsonSchema(zodSchema: z.ZodType): MCPJsonSchema {
	const jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' })
	return {
		type: 'object',
		...jsonSchema,
	} as MCPJsonSchema
}

export function mcpToolToToolDefinition(
	tool: MCPToolDefinition,
	client: MCPClient,
	serverName: string,
): ToolDefinition {
	const inputSchema = mcpJsonSchemaToZod(tool.inputSchema)
	const toolName = `mcp_${serverName}_${tool.name}`

	return {
		name: toolName,
		description: tool.description
			? `[MCP:${serverName}] ${tool.description}`
			: `[MCP:${serverName}] ${tool.name}`,
		inputSchema,
		category: 'network',
		permissions: ['network_access'],
		isReadOnly: () => tool.annotations?.readOnlyHint ?? false,
		isDestructive: () => tool.annotations?.destructiveHint ?? false,
		isConcurrencySafe: () => true,

		async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
			const result = await client.callTool(tool.name, input as Record<string, unknown>)
			return mcpToolResultToToolResult(result)
		},
	}
}

export function toolDefinitionToMCPTool(tool: ToolDefinition): MCPToolDefinition {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: zodToMCPJsonSchema(tool.inputSchema),
		annotations: {
			readOnlyHint: tool.isReadOnly?.(undefined as never),
			destructiveHint: tool.isDestructive?.(undefined as never),
		},
	}
}

export function mcpToolResultToToolResult(result: MCPToolResult): ToolResult {
	const textContent = result.content
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
		.join('\n')

	return {
		success: !result.isError,
		output: textContent,
		data: result.content,
		error: result.isError ? textContent : undefined,
	}
}

export function toolResultToMCPToolResult(result: ToolResult): MCPToolResult {
	const content: MCPToolResult['content'] = []

	if (result.output) {
		content.push({ type: 'text', text: result.output })
	}

	if (!result.success && result.error) {
		content.push({ type: 'text', text: result.error })
	}

	if (content.length === 0) {
		content.push({ type: 'text', text: '' })
	}

	return {
		content,
		isError: !result.success,
	}
}
