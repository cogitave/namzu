import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ToolDefinition } from '../types/tool/index.js'
import { toolset } from './toolset.js'

function tool(name: string): ToolDefinition {
	return {
		name,
		description: `${name} tool`,
		inputSchema: z.object({}),
		async execute() {
			return { success: true, output: `${name} ran` }
		},
	} as unknown as ToolDefinition
}

describe('toolset', () => {
	it('reports the tools it was given, in the order given', () => {
		const ts = toolset('demo', [tool('a'), tool('b')])
		expect(ts.tools().map((t) => t.name)).toEqual(['a', 'b'])
	})

	it('gives a plain string source a host_tool source using the string as id and name', () => {
		const ts = toolset('demo', [])
		expect(ts.source).toEqual({ id: 'demo', kind: 'host_tool', name: 'demo' })
	})

	it('keeps a full ToolSource exactly as given', () => {
		const source = { id: 'mcp:github', kind: 'mcp_server' as const, name: 'GitHub' }
		const ts = toolset(source, [])
		expect(ts.source).toBe(source)
	})

	it('snapshots the tools array so a later mutation of the caller-owned array is invisible', () => {
		const tools = [tool('a')]
		const ts = toolset('demo', tools)
		tools.push(tool('b'))
		expect(ts.tools().map((t) => t.name)).toEqual(['a'])
	})

	it('has no onChange or close — a plain toolset never changes on its own', () => {
		const ts = toolset('demo', [tool('a')])
		expect(ts.onChange).toBeUndefined()
		expect(ts.close).toBeUndefined()
	})

	it('returns the same tool objects it was given (execute identity, every field)', () => {
		const a = tool('a')
		const ts = toolset('demo', [a])
		expect(ts.tools()[0]).toBe(a)
	})
})
