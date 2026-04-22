/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 5):
 *
 *   - `mcpJsonSchemaToZod(schema)`:
 *     - Empty / no-properties object → passthrough `z.object({})`.
 *     - Maps primitive types (string, number, integer, boolean, array,
 *       object) to zod equivalents.
 *     - Unknown / null property types → `z.unknown()`.
 *     - Fields not in `required[]` are `.optional()`.
 *   - `zodToMCPJsonSchema(zodSchema)` wraps `zodToJsonSchema` with
 *     `type: 'object'` prefixed.
 *   - `mcpToolToToolDefinition(tool, client, serverName)` produces a
 *     ToolDefinition:
 *     - name = `mcp_<server>_<tool.name>`
 *     - description prefixed `[MCP:<server>] <tool.description or name>`
 *     - category = 'network', permissions = ['network_access']
 *     - readOnly + destructive reflect MCP annotations; concurrency
 *       safe defaults to true.
 *     - `execute(input, ctx)` calls `client.callTool(tool.name, input)`
 *       and adapts the MCPToolResult.
 *   - `toolDefinitionToMCPTool(tool)` projects name/description +
 *     converts inputSchema + copies annotations.
 *   - `mcpToolResultToToolResult`:
 *     - success = !isError.
 *     - output = text content joined with '\n' (non-text blocks
 *       kept in `data` only).
 *     - error = same joined text when isError, else undefined.
 *   - `toolResultToMCPToolResult`:
 *     - success + output → single text block.
 *     - failure + error → single text block + isError.
 *     - Empty output on success → single empty-text block.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { MCPJsonSchema, MCPToolResult } from '../../types/connector/index.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../../types/tool/index.js'

import {
	mcpJsonSchemaToZod,
	mcpToolResultToToolResult,
	mcpToolToToolDefinition,
	toolDefinitionToMCPTool,
	toolResultToMCPToolResult,
	zodToMCPJsonSchema,
} from './adapter.js'
import type { MCPClient } from './client.js'

function mockClient(result: MCPToolResult): MCPClient {
	return {
		callTool: vi.fn(async () => result),
	} as unknown as MCPClient
}

describe('mcpJsonSchemaToZod', () => {
	it('empty schema → passthrough empty object', () => {
		const schema = mcpJsonSchemaToZod({ type: 'object' } as MCPJsonSchema)
		expect(() => schema.parse({ extra: 'x' })).not.toThrow()
	})

	it('maps primitive types', () => {
		const schema = mcpJsonSchemaToZod({
			type: 'object',
			required: ['s', 'n', 'b', 'arr', 'obj'],
			properties: {
				s: { type: 'string' },
				n: { type: 'number' },
				b: { type: 'boolean' },
				arr: { type: 'array' },
				obj: { type: 'object' },
			},
		} as MCPJsonSchema)
		expect(() => schema.parse({ s: 'x', n: 1, b: true, arr: [], obj: {} })).not.toThrow()
		expect(() => schema.parse({ s: 123, n: 1, b: true, arr: [], obj: {} })).toThrow()
	})

	it('optional fields are not required', () => {
		const schema = mcpJsonSchemaToZod({
			type: 'object',
			required: ['a'],
			properties: {
				a: { type: 'string' },
				b: { type: 'string' },
			},
		} as MCPJsonSchema)
		expect(() => schema.parse({ a: 'x' })).not.toThrow()
	})

	it('unknown property types map to z.unknown (pass any value)', () => {
		const schema = mcpJsonSchemaToZod({
			type: 'object',
			required: ['x'],
			properties: { x: { type: 'weird' } },
		} as MCPJsonSchema)
		expect(() => schema.parse({ x: { nested: [1, 2] } })).not.toThrow()
	})
})

describe('zodToMCPJsonSchema', () => {
	it('wraps zod schema with type: object', () => {
		const out = zodToMCPJsonSchema(z.object({ a: z.string() }))
		expect(out.type).toBe('object')
	})
})

describe('mcpToolToToolDefinition', () => {
	it('prefixes name + description with the server handle', () => {
		const tool = mcpToolToToolDefinition(
			{
				name: 'search',
				description: 'search docs',
				inputSchema: { type: 'object' } as MCPJsonSchema,
			},
			mockClient({ content: [{ type: 'text', text: 'ok' }], isError: false }),
			'serverA',
		)
		expect(tool.name).toBe('mcp_serverA_search')
		expect(tool.description).toBe('[MCP:serverA] search docs')
		expect(tool.category).toBe('network')
	})

	it('uses tool.name as description fallback when no description', () => {
		const tool = mcpToolToToolDefinition(
			{ name: 'search', inputSchema: { type: 'object' } as MCPJsonSchema },
			mockClient({ content: [{ type: 'text', text: 'ok' }], isError: false }),
			'serverA',
		)
		expect(tool.description).toBe('[MCP:serverA] search')
	})

	it('reflects MCP annotations into tool flags', () => {
		const tool = mcpToolToToolDefinition(
			{
				name: 't',
				inputSchema: { type: 'object' } as MCPJsonSchema,
				annotations: { readOnlyHint: true, destructiveHint: true },
			},
			mockClient({ content: [], isError: false }),
			's',
		)
		expect(tool.isReadOnly?.({})).toBe(true)
		expect(tool.isDestructive?.({})).toBe(true)
		expect(tool.isConcurrencySafe?.({})).toBe(true)
	})

	it('default flags when annotations are absent', () => {
		const tool = mcpToolToToolDefinition(
			{ name: 't', inputSchema: { type: 'object' } as MCPJsonSchema },
			mockClient({ content: [], isError: false }),
			's',
		)
		expect(tool.isReadOnly?.({})).toBe(false)
		expect(tool.isDestructive?.({})).toBe(false)
	})

	it('execute calls client.callTool(tool.name, input) and adapts result', async () => {
		const client = mockClient({
			content: [{ type: 'text', text: 'hello' }],
			isError: false,
		})
		const tool = mcpToolToToolDefinition(
			{ name: 'search', inputSchema: { type: 'object' } as MCPJsonSchema },
			client,
			's',
		)
		const result = await tool.execute({ q: 'hi' }, {} as ToolContext)
		expect(client.callTool).toHaveBeenCalledWith('search', { q: 'hi' })
		expect(result.success).toBe(true)
		expect(result.output).toBe('hello')
	})
})

describe('toolDefinitionToMCPTool', () => {
	it('projects name / description / inputSchema / annotations', () => {
		const tool: ToolDefinition = {
			name: 't',
			description: 'd',
			inputSchema: z.object({ a: z.string() }),
			async execute() {
				return { success: true, output: '' }
			},
			isReadOnly: () => true,
			isDestructive: () => false,
		}
		const out = toolDefinitionToMCPTool(tool)
		expect(out.name).toBe('t')
		expect(out.description).toBe('d')
		expect(out.inputSchema.type).toBe('object')
		expect(out.annotations).toEqual({ readOnlyHint: true, destructiveHint: false })
	})
})

describe('mcpToolResultToToolResult', () => {
	it('joins text blocks with \\n for output', () => {
		const result = mcpToolResultToToolResult({
			content: [
				{ type: 'text', text: 'line 1' },
				{ type: 'text', text: 'line 2' },
			],
			isError: false,
		})
		expect(result.output).toBe('line 1\nline 2')
		expect(result.success).toBe(true)
	})

	it('filters out non-text blocks from output but keeps them in data', () => {
		const result = mcpToolResultToToolResult({
			content: [
				{ type: 'text', text: 'text' },
				{ type: 'image', data: 'b64', mimeType: 'image/png' },
			],
			isError: false,
		})
		expect(result.output).toBe('text')
		expect(Array.isArray(result.data)).toBe(true)
	})

	it('sets error field when isError is true', () => {
		const result = mcpToolResultToToolResult({
			content: [{ type: 'text', text: 'boom' }],
			isError: true,
		})
		expect(result.success).toBe(false)
		expect(result.error).toBe('boom')
	})
})

describe('toolResultToMCPToolResult', () => {
	it('success + output → single text block', () => {
		const result: ToolResult = { success: true, output: 'ok' }
		const out = toolResultToMCPToolResult(result)
		expect(out.content).toEqual([{ type: 'text', text: 'ok' }])
		expect(out.isError).toBe(false)
	})

	it('failure + error → text block + isError', () => {
		const result: ToolResult = { success: false, output: '', error: 'boom' }
		const out = toolResultToMCPToolResult(result)
		expect(out.content.some((b) => b.type === 'text' && b.text === 'boom')).toBe(true)
		expect(out.isError).toBe(true)
	})

	it('success with empty output → one empty-text block', () => {
		const result: ToolResult = { success: true, output: '' }
		const out = toolResultToMCPToolResult(result)
		expect(out.content).toEqual([{ type: 'text', text: '' }])
	})
})
