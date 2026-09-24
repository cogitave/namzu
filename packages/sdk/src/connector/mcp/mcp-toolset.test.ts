import { describe, expect, it } from 'vitest'

import { ToolManager } from '../../toolsets/manager.js'
import type { MCPToolDefinition } from '../../types/connector/index.js'
import type { ToolContext } from '../../types/tool/index.js'
import type { Logger } from '../../utils/logger.js'
import { scriptedMcpServer } from './__fixtures__/scripted-mcp-server.js'
import { type MCPToolsets, mcpToolset, mcpToolsetName } from './mcp-toolset.js'

function allTools(toolsets: MCPToolsets) {
	return toolsets.flatMap((toolset) => toolset.tools())
}

function stubLogger(): Logger & { errors: unknown[][] } {
	const errors: unknown[][] = []
	const logger: Logger & { errors: unknown[][] } = {
		errors,
		debug: () => undefined,
		info: () => undefined,
		warn: () => undefined,
		error: (...args) => errors.push(args),
		child: () => logger,
	}
	return logger
}

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

		const names = allTools(ts).map((t) => t.name)
		expect(names).toContain('mcp__demo__echo')
		expect(names).toContain('mcp__demo__prompt__summarize')
	})

	it('carries the server instructions onto the source', async () => {
		const server = scriptedMcpServer({ tools: [echoTool], instructions: 'Use echo sparingly.' })
		await server.client.connect()

		const ts = await mcpToolset(server.client)

		expect(ts[0].source.description).toBe('Use echo sparingly.')
		expect(ts[0].source.kind).toBe('mcp_server')
	})

	it('defaults the source id to mcp:<server>, and a caller may override it', async () => {
		const server = scriptedMcpServer({ serverName: 'gh', tools: [echoTool] })
		await server.client.connect()

		const defaulted = await mcpToolset(server.client)
		expect(defaulted[0].source.id).toBe('mcp:gh')

		const server2 = scriptedMcpServer({ serverName: 'gh', tools: [echoTool] })
		await server2.client.connect()
		const withId = await mcpToolset(server2.client, { id: 'plugin:acme/mcp:gh' })
		expect(withId[0].source.id).toBe('plugin:acme/mcp:gh')
	})

	it('keeps resource tools deferred and carries the host trust decision on their source', async () => {
		const server = scriptedMcpServer({
			serverName: 'demo',
			tools: [echoTool],
			resources: [{ uri: 'file:///a.txt', name: 'a' }],
		})
		await server.client.connect()
		const entries = await mcpToolset(server.client, { readOnlyHintTrusted: true })
		const manager = new ToolManager({ toolsets: entries, messages: () => [] })
		expect(entries[1].availability).toBe('deferred')
		expect(manager.availability('mcp__demo__list_resources')).toBe('deferred')
		expect(manager.sourceOf('mcp__demo__list_resources').readOnlyHintTrusted).toBe(true)
		expect(manager.sourceOf('mcp__demo__echo').readOnlyHintTrusted).toBe(true)
		await entries[0].close?.()
	})

	it('refuses a server tool whose name collides with a resource tool', async () => {
		const server = scriptedMcpServer({
			serverName: 'demo',
			tools: [{ ...echoTool, name: 'list_resources' }],
			resources: [{ uri: 'file:///a.txt', name: 'a' }],
		})
		await server.client.connect()
		await expect(mcpToolset(server.client)).rejects.toThrow(/not unique/)
	})

	describe('policy', () => {
		it('never admits a denied tool name', async () => {
			const server = scriptedMcpServer({
				serverName: 'demo',
				tools: [echoTool, { ...echoTool, name: 'dangerous' }],
			})
			await server.client.connect()

			const ts = await mcpToolset(server.client, { deny: ['dangerous'] })

			const names = allTools(ts).map((t) => t.name)
			expect(names).toContain('mcp__demo__echo')
			expect(names).not.toContain('mcp__demo__dangerous')
		})

		it('never lists or admits a denied resource, on first discovery or after list_changed', async () => {
			const server = scriptedMcpServer({
				serverName: 'demo',
				resources: [
					{ uri: 'file:///a.txt', name: 'a' },
					{ uri: 'file:///secret.txt', name: 'secret' },
				],
			})
			await server.client.connect()

			const ts = await mcpToolset(server.client, { deny: ['secret'] })
			const listResources = allTools(ts).find((t) => t.name === 'mcp__demo__list_resources')
			const readResource = allTools(ts).find((t) => t.name === 'mcp__demo__read_resource')
			if (!listResources || !readResource) throw new Error('resource tools missing')

			const listed = await listResources.execute({}, {
				abortSignal: new AbortController().signal,
			} as ToolContext)
			expect(listed.success).toBe(true)
			expect(listed.output).toContain('file:///a.txt')
			expect(listed.output).not.toContain('secret')

			const deniedRead = await readResource.execute({ uri: 'file:///secret.txt' }, {
				abortSignal: new AbortController().signal,
			} as ToolContext)
			expect(deniedRead.success).toBe(false)
			expect(deniedRead.error).toContain('is not a resource')
			// Never even reached the server — refused on admission, same as an
			// unknown uri, not merely refused after a round trip.
			expect(server.resourceReads).toEqual([])

			// A re-discovery (`resources/list_changed`) re-applies the same
			// policy — a resource added later cannot bypass `deny` either.
			const changed = waitForChange(ts[0].onChange)
			server.setResources([
				{ uri: 'file:///a.txt', name: 'a' },
				{ uri: 'file:///secret.txt', name: 'secret' },
				{ uri: 'file:///b.txt', name: 'b' },
			])
			server.fireListChanged('resources')
			await changed

			const stillDenied = await readResource.execute({ uri: 'file:///secret.txt' }, {
				abortSignal: new AbortController().signal,
			} as ToolContext)
			expect(stillDenied.success).toBe(false)

			const newlyAdmitted = await readResource.execute({ uri: 'file:///b.txt' }, {
				abortSignal: new AbortController().signal,
			} as ToolContext)
			expect(newlyAdmitted.success).toBe(true)
		})
	})

	describe('list_changed', () => {
		it('refreshes and fires onChange when the server advertises tools.listChanged', async () => {
			const server = scriptedMcpServer({ serverName: 'demo', tools: [echoTool] })
			await server.client.connect()
			const ts = await mcpToolset(server.client)
			expect(allTools(ts).map((t) => t.name)).toEqual(['mcp__demo__echo'])

			const changed = waitForChange(ts[0].onChange)
			server.setTools([echoTool, { ...echoTool, name: 'second' }])
			server.fireListChanged('tools')
			await changed

			expect(
				allTools(ts)
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

			const changed = waitForChange(ts[0].onChange)
			server.setTools([echoTool])
			server.fireListChanged('tools')
			await changed

			expect(allTools(ts).map((t) => t.name)).toEqual(['mcp__demo__echo'])
		})

		it('reports a changed description as drift, through onDrift', async () => {
			const server = scriptedMcpServer({ serverName: 'demo', tools: [echoTool] })
			await server.client.connect()
			const drifts: string[][] = []
			const ts = await mcpToolset(server.client, {
				onDrift: (event) => drifts.push(event.drift.changed),
			})

			const changed = waitForChange(ts[0].onChange)
			server.setTools([{ ...echoTool, description: 'Echoes, loudly.' }])
			server.fireListChanged('tools')
			await changed

			expect(drifts).toEqual([['echo']])
			// The changed definition is admitted, not held back — a later item
			// (the ToolManager, plan.md §2) is what holds a changed definition
			// while the previously admitted one keeps serving; a toolset by
			// itself only ever reports its current truth.
			const tool = allTools(ts).find((t) => t.name === 'mcp__demo__echo')
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
			expect(allTools(ts).map((t) => t.name)).toEqual(['mcp__demo__echo'])
		})
	})

	describe('reconnect', () => {
		it('re-subscribes and re-fetches after the transport drops', async () => {
			const server = scriptedMcpServer({ serverName: 'demo', tools: [echoTool] })
			await server.client.connect()
			const ts = await mcpToolset(server.client, {
				reconnect: { initialDelayMs: 1, maxDelayMs: 5, maxAttempts: 5 },
			})
			expect(allTools(ts).map((t) => t.name)).toEqual(['mcp__demo__echo'])

			// The server changed its tool set while this client was down — not
			// a notification (there is nobody connected to notify), so only a
			// fresh discovery after reconnecting can see it.
			server.setTools([{ ...echoTool, name: 'reconnected' }])
			const changed = waitForChange(ts[0].onChange)
			server.dropConnection()
			await changed

			expect(allTools(ts).map((t) => t.name)).toEqual(['mcp__demo__reconnected'])
			await ts[0].close?.()
		})

		it('gains resource tools after a reconnect negotiates the capability for the first time', async () => {
			const server = scriptedMcpServer({
				serverName: 'demo',
				tools: [echoTool],
				capabilities: {}, // no `resources` at all on the first connection
			})
			await server.client.connect()
			const ts = await mcpToolset(server.client, {
				reconnect: { initialDelayMs: 1, maxDelayMs: 5, maxAttempts: 5 },
			})
			expect(allTools(ts).map((t) => t.name)).not.toContain('mcp__demo__list_resources')

			// The server comes back from the reconnect with resources it never
			// advertised before — a restart with a newer build, not a
			// `resources/list_changed` notification (nobody was connected to
			// send or receive one).
			server.setCapabilities({ resources: { listChanged: true } })
			server.setResources([{ uri: 'file:///a.txt', name: 'a' }])
			const changed = waitForChange(ts[0].onChange)
			server.dropConnection()
			await changed

			const names = allTools(ts).map((t) => t.name)
			expect(names).toContain('mcp__demo__list_resources')
			expect(names).toContain('mcp__demo__read_resource')

			const readResource = allTools(ts).find((t) => t.name === 'mcp__demo__read_resource')
			if (!readResource) throw new Error('read_resource missing')
			const result = await readResource.execute({ uri: 'file:///a.txt' }, {
				abortSignal: new AbortController().signal,
			} as ToolContext)
			expect(result.success).toBe(true)
			await ts[0].close?.()
		})

		it('loses resource tools after a reconnect drops the capability', async () => {
			const server = scriptedMcpServer({
				serverName: 'demo',
				tools: [echoTool],
				resources: [{ uri: 'file:///a.txt', name: 'a' }],
			})
			await server.client.connect()
			const ts = await mcpToolset(server.client, {
				reconnect: { initialDelayMs: 1, maxDelayMs: 5, maxAttempts: 5 },
			})
			expect(allTools(ts).map((t) => t.name)).toContain('mcp__demo__list_resources')

			server.setCapabilities({}) // the reconnected server no longer serves resources
			const changed = waitForChange(ts[0].onChange)
			server.dropConnection()
			await changed

			expect(allTools(ts).map((t) => t.name)).not.toContain('mcp__demo__list_resources')
			await ts[0].close?.()
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
			const names = allTools(ts).map((t) => t.name)
			expect(names).toContain('mcp__demo__list_resources')
			expect(names).toContain('mcp__demo__read_resource')

			const readResource = allTools(ts).find((t) => t.name === 'mcp__demo__read_resource')
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
			const readResource = allTools(ts).find((t) => t.name === 'mcp__demo__read_resource')
			if (!readResource) throw new Error('read_resource missing')

			const changed = waitForChange(ts[0].onChange)
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

			expect(allTools(ts).some((t) => t.name.includes('list_resources'))).toBe(false)
			expect(ts[0].availability).toBe('deferred')
		})
	})

	describe('notification handler', () => {
		it('logs rather than leaves an unhandled rejection when a list_changed refresh fails', async () => {
			const server = scriptedMcpServer({ serverName: 'demo', tools: [echoTool] })
			await server.client.connect()
			const logger = stubLogger()
			const ts = await mcpToolset(server.client, { logger })

			const unhandled: unknown[] = []
			const onUnhandledRejection = (reason: unknown) => unhandled.push(reason)
			process.on('unhandledRejection', onUnhandledRejection)
			try {
				// The notification arrives and is queued for delivery, then the
				// connection drops before that delivery runs — so the `tools/list`
				// call the notification triggers hits an already-disconnected
				// client. Both calls are synchronous; the race is in the
				// microtask the notification itself is delivered on.
				server.fireListChanged('tools')
				server.dropConnection()
				await flush()
			} finally {
				process.off('unhandledRejection', onUnhandledRejection)
			}

			expect(unhandled).toEqual([])
			expect(logger.errors.length).toBeGreaterThan(0)
			expect(String(logger.errors[0]?.[0])).toContain('Failed to refresh MCP tools')
			await ts[0].close?.()
		})
	})

	describe('close', () => {
		it('releases the onNotification subscription it registered', async () => {
			const server = scriptedMcpServer({ serverName: 'demo', tools: [echoTool] })
			await server.client.connect()
			const ts = await mcpToolset(server.client)

			const client = server.client as unknown as {
				notificationHandlers: unknown[]
			}
			expect(client.notificationHandlers.length).toBeGreaterThan(0)
			const before = client.notificationHandlers.length

			await ts[0].close?.()

			expect(client.notificationHandlers.length).toBe(before - 1)
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
			const built = allTools(ts).find((t) => t.name.startsWith('mcp__demo__aaaa'))
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

			const tool = allTools(ts).find((t) => t.name === 'mcp__demo__echo')
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
			const tool = allTools(ts).find((t) => t.name === 'mcp__demo__echo')
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
