import { describe, expect, it } from 'vitest'

import type { MCPToolDefinition } from '../../types/connector/index.js'
import type { ToolContext } from '../../types/tool/index.js'
import { scriptedMcpServer } from './__fixtures__/scripted-mcp-server.js'
import { mcpToolset, mcpToolsetName } from './mcp-toolset.js'

function waitForChange(
	onChange: ((listener: () => void) => () => void) | undefined,
): Promise<void> {
	if (!onChange) throw new Error('toolset has no onChange')
	return new Promise((resolve) => {
		const off = onChange(() => {
			off()
			resolve()
		})
	})
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0))
}

const echoTool: MCPToolDefinition = {
	name: 'echo',
	description: 'Echoes its input',
	inputSchema: { type: 'object', properties: {} },
}

describe('mcpToolset', () => {
	it('refuses to build against a client that is not connected', async () => {
		const server = scriptedMcpServer({ tools: [echoTool] })
		await expect(mcpToolset(server.client)).rejects.toThrow(/must be connected/)
	})

	it('names a tool mcp__<server>__<tool> and a prompt mcp__<server>__prompt__<name>', async () => {
		const server = scriptedMcpServer({
			serverName: 'demo',
			tools: [echoTool],
			prompts: [{ name: 'summarize', arguments: [] }],
		})
		await server.client.connect()

		const ts = await mcpToolset(server.client)

		const names = ts.tools().map((t) => t.name)
		expect(names).toContain('mcp__demo__echo')
		expect(names).toContain('mcp__demo__prompt__summarize')
	})

	it('carries the server instructions onto the source', async () => {
		const server = scriptedMcpServer({ tools: [echoTool], instructions: 'Use echo sparingly.' })
		await server.client.connect()

		const ts = await mcpToolset(server.client)

		expect(ts.source.description).toBe('Use echo sparingly.')
		expect(ts.source.kind).toBe('mcp_server')
	})

	it('defaults the source id to mcp:<server>, and a caller may override it', async () => {
		const server = scriptedMcpServer({ serverName: 'gh', tools: [echoTool] })
		await server.client.connect()

		const defaulted = await mcpToolset(server.client)
		expect(defaulted.source.id).toBe('mcp:gh')

		const server2 = scriptedMcpServer({ serverName: 'gh', tools: [echoTool] })
		await server2.client.connect()
		const withId = await mcpToolset(server2.client, { id: 'plugin:acme/mcp:gh' })
		expect(withId.source.id).toBe('plugin:acme/mcp:gh')
	})

	describe('policy', () => {
		it('never admits a denied tool name', async () => {
			const server = scriptedMcpServer({
				serverName: 'demo',
				tools: [echoTool, { ...echoTool, name: 'dangerous' }],
			})
			await server.client.connect()

			const ts = await mcpToolset(server.client, { deny: ['dangerous'] })

			const names = ts.tools().map((t) => t.name)
			expect(names).toContain('mcp__demo__echo')
			expect(names).not.toContain('mcp__demo__dangerous')
		})
	})

	describe('list_changed', () => {
		it('refreshes and fires onChange when the server advertises tools.listChanged', async () => {
			const server = scriptedMcpServer({ serverName: 'demo', tools: [echoTool] })
			await server.client.connect()
			const ts = await mcpToolset(server.client)
			expect(ts.tools().map((t) => t.name)).toEqual(['mcp__demo__echo'])

			const changed = waitForChange(ts.onChange)
			server.setTools([echoTool, { ...echoTool, name: 'second' }])
			server.fireListChanged('tools')
			await changed

			expect(
				ts
					.tools()
					.map((t) => t.name)
					.sort(),
			).toEqual(['mcp__demo__echo', 'mcp__demo__second'])
		})

		it('reports a removed tool the same way', async () => {
			const server = scriptedMcpServer({
				serverName: 'demo',
				tools: [echoTool, { ...echoTool, name: 'second' }],
			})
			await server.client.connect()
			const ts = await mcpToolset(server.client)

			const changed = waitForChange(ts.onChange)
			server.setTools([echoTool])
			server.fireListChanged('tools')
			await changed

			expect(ts.tools().map((t) => t.name)).toEqual(['mcp__demo__echo'])
		})

		it('reports a changed description as drift, through onDrift', async () => {
			const server = scriptedMcpServer({ serverName: 'demo', tools: [echoTool] })
			await server.client.connect()
			const drifts: string[][] = []
			const ts = await mcpToolset(server.client, {
				onDrift: (event) => drifts.push(event.drift.changed),
			})

			const changed = waitForChange(ts.onChange)
			server.setTools([{ ...echoTool, description: 'Echoes, loudly.' }])
			server.fireListChanged('tools')
			await changed

			expect(drifts).toEqual([['echo']])
			// The changed definition is admitted, not held back — a later item
			// (the ToolManager, plan.md §2) is what holds a changed definition
			// while the previously admitted one keeps serving; a toolset by
			// itself only ever reports its current truth.
			const tool = ts.tools().find((t) => t.name === 'mcp__demo__echo')
			expect(tool?.description).toContain('Echoes, loudly.')
		})

		it('ignores a list_changed notification the server never advertised', async () => {
			const server = scriptedMcpServer({
				serverName: 'demo',
				tools: [echoTool],
				capabilities: {}, // no `tools.listChanged`, despite tools being served
			})
			await server.client.connect()
			const ts = await mcpToolset(server.client)

			server.setTools([echoTool, { ...echoTool, name: 'second' }])
			server.fireListChanged('tools')
			await flush()

			// A server that never declared the capability cannot make this
			// toolset re-fetch merely by sending the notification anyway.
			expect(ts.tools().map((t) => t.name)).toEqual(['mcp__demo__echo'])
		})
	})

	describe('reconnect', () => {
		it('re-subscribes and re-fetches after the transport drops', async () => {
			const server = scriptedMcpServer({ serverName: 'demo', tools: [echoTool] })
			await server.client.connect()
			const ts = await mcpToolset(server.client, {
				reconnect: { initialDelayMs: 1, maxDelayMs: 5, maxAttempts: 5 },
			})
			expect(ts.tools().map((t) => t.name)).toEqual(['mcp__demo__echo'])

			// The server changed its tool set while this client was down — not
			// a notification (there is nobody connected to notify), so only a
			// fresh discovery after reconnecting can see it.
			server.setTools([{ ...echoTool, name: 'reconnected' }])
			const changed = waitForChange(ts.onChange)
			server.dropConnection()
			await changed

			expect(ts.tools().map((t) => t.name)).toEqual(['mcp__demo__reconnected'])
			await ts.close?.()
		})
	})

	describe('resources', () => {
		it('serves list_resources and read_resource, admitting only a listed uri', async () => {
			const server = scriptedMcpServer({
				serverName: 'demo',
				resources: [{ uri: 'file:///a.txt', name: 'a' }],
			})
			await server.client.connect()

			const ts = await mcpToolset(server.client)
			const names = ts.tools().map((t) => t.name)
			expect(names).toContain('mcp__demo__list_resources')
			expect(names).toContain('mcp__demo__read_resource')

			const readResource = ts.tools().find((t) => t.name === 'mcp__demo__read_resource')
			if (!readResource) throw new Error('read_resource missing')

			const refused = await readResource.execute({ uri: 'file:///unknown.txt' }, {
				abortSignal: new AbortController().signal,
			} as ToolContext)
			expect(refused.success).toBe(false)
			expect(refused.error).toContain('is not a resource')

			const admitted = await readResource.execute({ uri: 'file:///a.txt' }, {
				abortSignal: new AbortController().signal,
			} as ToolContext)
			expect(admitted.success).toBe(true)
			expect(server.resourceReads).toEqual(['file:///a.txt'])
		})

		it('re-admits uris after resources.listChanged refreshes the catalogue', async () => {
			const server = scriptedMcpServer({
				serverName: 'demo',
				resources: [{ uri: 'file:///a.txt', name: 'a' }],
			})
			await server.client.connect()
			const ts = await mcpToolset(server.client)
			const readResource = ts.tools().find((t) => t.name === 'mcp__demo__read_resource')
			if (!readResource) throw new Error('read_resource missing')

			const changed = waitForChange(ts.onChange)
			server.setResources([{ uri: 'file:///b.txt', name: 'b' }])
			server.fireListChanged('resources')
			await changed

			const stillRefused = await readResource.execute({ uri: 'file:///a.txt' }, {
				abortSignal: new AbortController().signal,
			} as ToolContext)
			expect(stillRefused.success).toBe(false)

			const nowAdmitted = await readResource.execute({ uri: 'file:///b.txt' }, {
				abortSignal: new AbortController().signal,
			} as ToolContext)
			expect(nowAdmitted.success).toBe(true)
		})

		it('a server with no resources contributes no resource tools, and keeps its own availability', async () => {
			const server = scriptedMcpServer({ serverName: 'demo', tools: [echoTool] })
			await server.client.connect()

			const ts = await mcpToolset(server.client, { availability: 'deferred' })

			expect(ts.tools().some((t) => t.name.includes('list_resources'))).toBe(false)
			expect(ts.availability).toBe('deferred')
		})
	})

	describe('long names', () => {
		it('shortens a name over 64 characters deterministically instead of refusing it', async () => {
			const longName = 'a'.repeat(80)
			const server = scriptedMcpServer({
				serverName: 'demo',
				tools: [{ ...echoTool, name: longName }],
			})
			await server.client.connect()

			const ts = await mcpToolset(server.client)
			const built = ts.tools().find((t) => t.name.startsWith('mcp__demo__aaaa'))
			if (!built) throw new Error('long-named tool missing')

			expect(built.name.length).toBeLessThanOrEqual(64)
			expect(built.name).toBe(mcpToolsetName('demo', longName))
			expect(mcpToolsetName('demo', longName)).toBe(mcpToolsetName('demo', longName))
		})

		it('gives two different overlong names two different shortened results', () => {
			const a = mcpToolsetName('demo', `${'a'.repeat(70)}-one`)
			const b = mcpToolsetName('demo', `${'a'.repeat(70)}-two`)
			expect(a).not.toBe(b)
			expect(a.length).toBeLessThanOrEqual(64)
			expect(b.length).toBeLessThanOrEqual(64)
		})
	})

	describe('retries', () => {
		it('passes maxRetries through to every tool this server contributes', async () => {
			const server = scriptedMcpServer({ serverName: 'demo', tools: [echoTool] })
			await server.client.connect()

			const ts = await mcpToolset(server.client, { maxRetries: 2 })

			const tool = ts.tools().find((t) => t.name === 'mcp__demo__echo')
			expect(tool?.maxRetries).toBe(2)
		})

		it('marks only a safe-classified failure retryable, not an unknown-outcome one', async () => {
			const server = scriptedMcpServer({
				serverName: 'demo',
				tools: [echoTool],
				toolResults: {
					echo: { resultType: 'input_required', inputRequests: [{ method: 'elicitation/create' }] },
				},
			})
			await server.client.connect()
			const ts = await mcpToolset(server.client, { maxRetries: 3 })
			const tool = ts.tools().find((t) => t.name === 'mcp__demo__echo')
			if (!tool) throw new Error('echo tool missing')

			const result = await tool.execute({}, {
				abortSignal: new AbortController().signal,
			} as ToolContext)

			expect(result.success).toBe(false)
			expect(result.retryable).toBe(true)
			expect((result.data as { retrySafety?: string })?.retrySafety).toBe('safe')
		})
	})
})
