import { describe, expect, it } from 'vitest'

import { MCP_TOOL_DEADLINE_SLACK_MS } from '../../../constants/mcp/index.js'
import type { MCPToolDefinition, MCPTransportUnion } from '../../../types/connector/index.js'
import { mcpToolToToolDefinition } from '../adapter.js'
import { MCPClient } from '../client.js'
import { createMcpEraCache } from '../era.js'

const tool: MCPToolDefinition = {
	name: 'slow',
	inputSchema: { type: 'object', properties: {} },
}

function clientWith(config: Record<string, unknown>): MCPClient {
	return new MCPClient({
		serverName: 'fixture',
		transport: { type: 'stdio', command: 'unused' } as MCPTransportUnion,
		eraCache: createMcpEraCache(),
		...config,
	})
}

describe('the tool deadline covers a progress-extended call', () => {
	it('carries no timeoutMs when the option is off, so the executor default is untouched', () => {
		const def = mcpToolToToolDefinition(tool, clientWith({ requestTimeoutMs: 1000 }), 'fixture')
		expect(def.timeoutMs).toBeUndefined()
	})

	it('carries the total cap plus slack when the option is on', () => {
		const def = mcpToolToToolDefinition(
			tool,
			clientWith({
				requestTimeoutMs: 1000,
				resetTimeoutOnProgress: true,
				maxTotalTimeoutMs: 600_000,
			}),
			'fixture',
		)
		expect(def.timeoutMs).toBe(600_000 + MCP_TOOL_DEADLINE_SLACK_MS)
	})

	it('uses the default cap (10x the request deadline) beyond the executor default of 120 s', () => {
		const def = mcpToolToToolDefinition(
			tool,
			clientWith({ resetTimeoutOnProgress: true }),
			'fixture',
		)
		expect(def.timeoutMs).toBe(300_000 + MCP_TOOL_DEADLINE_SLACK_MS)
		expect(def.timeoutMs as number).toBeGreaterThan(120_000)
	})

	it('never exceeds the largest timer delay', () => {
		const def = mcpToolToToolDefinition(
			tool,
			clientWith({ resetTimeoutOnProgress: true, maxTotalTimeoutMs: 2_147_483_647 }),
			'fixture',
		)
		expect(def.timeoutMs).toBe(2_147_483_647)
	})
})
