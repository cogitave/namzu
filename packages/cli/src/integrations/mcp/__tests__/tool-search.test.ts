import { type ToolDefinition, type Toolset, mcpJsonSchemaToZod, toolset } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import {
	MCP_TOOL_SEARCH_PERCENT,
	decideMcpToolSearch,
	deferLargeMcpToolsets,
	mcpToolSearchThreshold,
} from '../tool-search.js'

/** A tool whose wire schema carries `padding` characters of description, standing in for a large server's schemas. */
function tool(name: string, padding = 0): ToolDefinition {
	return {
		name,
		description: `${name} does one thing.`,
		inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: { q: { type: 'string' } } }),
		modelInputSchema: {
			type: 'object',
			properties: { q: { type: 'string', description: 'x'.repeat(padding) } },
		},
		execute: async () => ({ success: true, output: '' }),
	} as unknown as ToolDefinition
}

/** An external server's main toolset, as `createMcpToolset` builds it. */
function server(name: string, tools: readonly ToolDefinition[]): Toolset {
	return {
		source: { id: `mcp:${name}`, kind: 'mcp_server', name, mcpServer: { name } },
		tools: () => tools,
	}
}

const WINDOW = 200_000

describe('external tool search', () => {
	it('defers at a tenth of the window, measured at 2.5 characters per token', () => {
		expect(MCP_TOOL_SEARCH_PERCENT).toBe(10)
		expect(mcpToolSearchThreshold(WINDOW)).toBe(50_000)
		expect(mcpToolSearchThreshold(128_000)).toBe(32_000)
	})

	it('leaves a small server loaded, and returns nothing to swap', () => {
		const small = server('tickets', [tool('mcp__tickets__create'), tool('mcp__tickets__list')])
		const decision = decideMcpToolSearch([small], WINDOW)
		expect(decision.defer).toBe(false)
		expect(decision.chars).toBeGreaterThan(0)
		expect(deferLargeMcpToolsets([small], WINDOW)).toBeUndefined()
	})

	it('defers every loaded server once their definitions together reach the threshold', () => {
		const a = server('a', [tool('mcp__a__one', 30_000)])
		const b = server('b', [tool('mcp__b__two', 30_000)])
		// Neither alone reaches 50,000 characters; together they do, as in the
		// reference, which sums every deferrable tool.
		expect(decideMcpToolSearch([a], WINDOW).defer).toBe(false)
		const swapped = deferLargeMcpToolsets([a, b], WINDOW)
		expect(swapped?.map((ts) => ts.availability)).toEqual(['deferred', 'deferred'])
		expect(swapped?.map((ts) => ts.tools().map((t) => t.name))).toEqual([
			['mcp__a__one'],
			['mcp__b__two'],
		])
	})

	it('decides against the window it is given, so a smaller model defers what a larger one carries', () => {
		const mid = server('mid', [tool('mcp__mid__x', 40_000)])
		expect(decideMcpToolSearch([mid], 1_000_000).defer).toBe(false)
		expect(decideMcpToolSearch([mid], 128_000).defer).toBe(true)
	})

	it('touches only external servers that are still loaded', () => {
		const big = server('big', [tool('mcp__big__x', 60_000)])
		const host = toolset('host', [tool('read_file', 60_000)])
		const alreadyDeferred: Toolset = {
			...server('res', [tool('mcp__res__read')]),
			availability: 'deferred',
		}
		const swapped = deferLargeMcpToolsets([host, big, alreadyDeferred], WINDOW)
		expect(swapped?.[0]).toBe(host)
		expect(swapped?.[1]?.availability).toBe('deferred')
		expect(swapped?.[2]).toBe(alreadyDeferred)
		// A host tool's size never counts: only external definitions can be deferred.
		expect(decideMcpToolSearch([host], WINDOW)).toMatchObject({ defer: false, chars: 0 })
	})

	it('defers nothing when no external server is connected', () => {
		expect(deferLargeMcpToolsets([toolset('host', [tool('read_file')])], 1)).toBeUndefined()
	})
})
