import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type {
	MCPJsonSchema,
	MCPToolDefinition,
	MCPToolResult,
} from '../../types/connector/index.js'
import type { ToolResultBlock } from '../../types/message/index.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../../types/tool/index.js'
import type { MCPClient } from './client.js'

/**
 * Convert an MCP server's declared input schema into the Zod type namzu
 * validates and re-renders with.
 *
 * The re-render is why fidelity matters here. A bridged tool's schema makes
 * a round trip — server JSON Schema → Zod → JSON Schema on the wire — and
 * whatever this function drops is dropped from what the MODEL is shown. The
 * previous version collapsed `array` to `z.array(z.unknown())` and `object`
 * to `z.record(z.unknown())`, so every MCP tool taking a structured
 * argument was presented as "an array of anything" or "an object with any
 * keys". Nested properties, item types, enums, and descriptions all
 * vanished, and the model was left guessing at a shape the server had
 * spelled out precisely.
 */
export function mcpJsonSchemaToZod(schema: MCPJsonSchema): z.ZodType {
	return objectToZod(schema as unknown as Record<string, unknown>)
}

function objectToZod(schema: Record<string, unknown>): z.ZodType {
	const properties = schema.properties as Record<string, unknown> | undefined
	if (!properties || Object.keys(properties).length === 0) {
		return closeOrOpen(z.object({}), schema)
	}

	const shape: Record<string, z.ZodType> = {}
	const required = new Set((schema.required as string[] | undefined) ?? [])

	for (const [key, propSchema] of Object.entries(properties)) {
		const field = jsonSchemaPropertyToZod(propSchema)
		shape[key] = required.has(key) ? field : field.optional()
	}

	return closeOrOpen(z.object(shape), schema)
}

/**
 * Honor the server's `additionalProperties`, defaulting to closed.
 *
 * The old default was `.passthrough()`, which renders as
 * `additionalProperties: true` — telling the model it may invent arguments
 * the server never declared. Zod's default `.strip()` renders `false` and
 * silently drops undeclared keys rather than rejecting them, so the
 * contract shown to the model tightens without turning a server's
 * incomplete schema into a hard validation failure.
 */
function closeOrOpen(obj: z.ZodObject<z.ZodRawShape>, schema: Record<string, unknown>): z.ZodType {
	return schema.additionalProperties === true ? obj.passthrough() : obj
}

function jsonSchemaPropertyToZod(prop: unknown): z.ZodType {
	if (typeof prop !== 'object' || prop === null) return z.unknown()
	const schema = prop as Record<string, unknown>

	let base = baseTypeToZod(schema)

	// `type: ['string', 'null']` is how a JSON Schema says nullable.
	if (Array.isArray(schema.type) && schema.type.includes('null')) {
		base = base.nullable()
	}

	const description = schema.description
	if (typeof description === 'string' && description.length > 0) {
		base = base.describe(description)
	}

	if (schema.default !== undefined) {
		base = base.default(schema.default)
	}

	return base
}

function baseTypeToZod(schema: Record<string, unknown>): z.ZodType {
	// An `enum` pins the value more tightly than `type` does, so it wins.
	const enumValues = schema.enum
	if (Array.isArray(enumValues) && enumValues.length > 0) {
		return enumToZod(enumValues)
	}
	if (schema.const !== undefined) {
		return z.literal(schema.const as z.Primitive)
	}

	const composite = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined
	if (Array.isArray(composite) && composite.length > 0) {
		const members = composite.map(jsonSchemaPropertyToZod)
		return members.length === 1
			? (members[0] as z.ZodType)
			: z.union(members as [z.ZodType, z.ZodType, ...z.ZodType[]])
	}

	// A union type (`['string','null']`) resolves through its non-null half;
	// `jsonSchemaPropertyToZod` adds `.nullable()` back on top.
	const type = Array.isArray(schema.type)
		? (schema.type as string[]).find((t) => t !== 'null')
		: (schema.type as string | undefined)

	switch (type) {
		case 'string':
			return z.string()
		case 'number':
			return z.number()
		case 'integer':
			return z.number().int()
		case 'boolean':
			return z.boolean()
		case 'null':
			return z.null()
		case 'array': {
			const items = schema.items
			// A tuple (`items` as an array) is rare in tool schemas; treat it
			// as a heterogeneous list rather than pretending to model it.
			if (Array.isArray(items)) return z.array(z.unknown())
			return z.array(items === undefined ? z.unknown() : jsonSchemaPropertyToZod(items))
		}
		case 'object':
			return objectToZod(schema)
		default:
			return z.unknown()
	}
}

function enumToZod(values: readonly unknown[]): z.ZodType {
	if (values.every((v): v is string => typeof v === 'string')) {
		return z.enum(values as [string, ...string[]])
	}
	const literals = values.map((v) => z.literal(v as z.Primitive))
	return literals.length === 1
		? (literals[0] as z.ZodType)
		: z.union(literals as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
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

	// Non-text blocks used to be filtered out and never seen again: a
	// bridged MCP server returning a chart, a screenshot or a PDF had that
	// content silently discarded, even though `types/connector/mcp.ts`
	// modelled `image` and `resource` blocks all along. Pass them through
	// as model-visible content when any are present.
	const blocks: ToolResultBlock[] = []
	for (const block of result.content) {
		if (block.type === 'text') {
			blocks.push({ type: 'text', text: block.text })
		} else if (block.type === 'image' && block.data && block.mimeType) {
			blocks.push({ type: 'image', data: block.data, mediaType: block.mimeType })
		} else if (block.type === 'resource' && block.resource?.text) {
			// A resource with inline text is readable content; one that is
			// only a URI is a pointer the model cannot dereference, so it is
			// named rather than pretended to be present.
			blocks.push({ type: 'text', text: block.resource.text })
		}
	}
	const hasRichContent = blocks.some((b) => b.type !== 'text')

	return {
		success: !result.isError,
		output: textContent,
		...(hasRichContent ? { content: blocks } : {}),
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
