import { describe, expect, it, vi } from 'vitest'

import type { ClawtoolProxyTool } from './plugin.js'
import { CLAWTOOL_TOOL_PREFIX, clawtoolToolToDefinition } from './tooling.js'

function proxy(over: Partial<ClawtoolProxyTool> = {}): ClawtoolProxyTool {
	return {
		name: 'WebSearch',
		description: 'Search the web',
		inputSchema: {
			type: 'object',
			properties: { query: { type: 'string' } },
			required: ['query'],
		},
		source: 'clawtool',
		call: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }], isError: false })),
		...over,
	}
}

describe('clawtoolToolToDefinition', () => {
	it('namespaces the name and tags the description', () => {
		const def = clawtoolToolToDefinition(proxy())
		expect(def.name).toBe(`${CLAWTOOL_TOOL_PREFIX}WebSearch`)
		expect(def.description).toBe('[clawtool] Search the web')
	})

	it('builds a zod schema that accepts the declared input', () => {
		const def = clawtoolToolToDefinition(proxy())
		expect(def.inputSchema.safeParse({ query: 'hi' }).success).toBe(true)
	})

	it('flags bridged tools destructive (always prompt)', () => {
		const def = clawtoolToolToDefinition(proxy())
		expect(def.isDestructive?.({})).toBe(true)
		expect(def.isReadOnly?.({})).toBe(false)
	})

	it('forwards execution to clawtool and maps the text result', async () => {
		const call = vi.fn(async () => ({
			content: [{ type: 'text' as const, text: 'search results' }],
			isError: false,
		}))
		const def = clawtoolToolToDefinition(proxy({ call }))
		const result = await def.execute({ query: 'hi' }, {} as never)
		expect(call).toHaveBeenCalledWith({ query: 'hi' })
		expect(result.success).toBe(true)
		expect(result.output).toBe('search results')
	})

	it('maps an MCP error result to an unsuccessful ToolResult', async () => {
		const call = vi.fn(async () => ({
			content: [{ type: 'text' as const, text: 'boom' }],
			isError: true,
		}))
		const def = clawtoolToolToDefinition(proxy({ call }))
		const result = await def.execute({ query: 'hi' }, {} as never)
		expect(result.success).toBe(false)
		expect(result.error).toBe('boom')
	})

	it('falls back to the tool name when no description', () => {
		const def = clawtoolToolToDefinition(proxy({ description: '' }))
		expect(def.description).toBe('[clawtool] WebSearch')
	})
})
