import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientFor, fakeMcpServer } from '../__fixtures__/fake-mcp-server.js'

const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId'
const tool = (name: string) => ({ name, inputSchema: { type: 'object' } })

function toolsServer(
	revision: 'newest' | 'previous',
	hints: Record<string, unknown>,
	capabilities: Record<string, unknown> = {},
) {
	let generation = 0
	const server = fakeMcpServer({
		revision,
		capabilities,
		handlers: {
			'tools/list': () => ({
				result: {
					resultType: 'complete',
					tools: [tool(`t${++generation}`)],
					...hints,
				},
			}),
			'resources/read': (m) => ({
				result: {
					resultType: 'complete',
					contents: [{ uri: String(m.params?.uri), text: `v${++generation}` }],
					...hints,
				},
			}),
			'subscriptions/listen': () => new Promise<never>(() => {}),
		},
	})
	return server
}

describe('ttlMs and cacheScope', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('keeps a list for ttlMs and asks again once it is stale, not before', async () => {
		const server = toolsServer('newest', { ttlMs: 60_000, cacheScope: 'public' })
		const client = clientFor(server)
		await client.connect()
		expect((await client.listTools()).map((t) => t.name)).toEqual(['t1'])
		vi.setSystemTime(Date.now() + 59_999)
		expect((await client.listTools()).map((t) => t.name)).toEqual(['t1'])
		expect(server.requestsFor('tools/list')).toHaveLength(1)
		vi.setSystemTime(Date.now() + 2)
		expect((await client.listTools()).map((t) => t.name)).toEqual(['t2'])
		expect(server.requestsFor('tools/list')).toHaveLength(2)
		await client.disconnect()
	})

	it('keeps nothing for ttlMs of zero, a negative one, or none at all', async () => {
		for (const hints of [{ ttlMs: 0 }, { ttlMs: -5 }, {}]) {
			const server = toolsServer('newest', hints)
			const client = clientFor(server)
			await client.connect()
			await client.listTools()
			await client.listTools()
			expect(server.requestsFor('tools/list')).toHaveLength(2)
			await client.disconnect()
		}
	})

	it('caches each resource by its uri and each page by its cursor', async () => {
		const server = toolsServer('newest', { ttlMs: 10_000, cacheScope: 'public' })
		const client = clientFor(server)
		await client.connect()
		await client.readResource('file:///a')
		await client.readResource('file:///a')
		await client.readResource('file:///b')
		expect(server.requestsFor('resources/read')).toHaveLength(2)
		await client.disconnect()
	})

	it('drops a list the moment the server says it changed', async () => {
		const server = toolsServer(
			'newest',
			{ ttlMs: 600_000, cacheScope: 'public' },
			{
				tools: { listChanged: true },
			},
		)
		const client = clientFor(server)
		await client.connect()
		await client.listTools()
		const [listen] = server.requestsFor('subscriptions/listen')
		server.push({
			jsonrpc: '2.0',
			method: 'notifications/subscriptions/acknowledged',
			params: {
				_meta: { [SUBSCRIPTION_ID]: listen?.id },
				notifications: { toolsListChanged: true },
			},
		})
		// Acknowledgment re-lists once, so it also drops what was held.
		await client.listTools()
		expect(server.requestsFor('tools/list')).toHaveLength(2)
		server.push({
			jsonrpc: '2.0',
			method: 'notifications/tools/list_changed',
			params: { _meta: { [SUBSCRIPTION_ID]: listen?.id } },
		})
		expect((await client.listTools()).map((t) => t.name)).toEqual(['t3'])
		await client.disconnect()
	})

	it('serves a private result only to the same credential', async () => {
		const server = toolsServer('newest', { ttlMs: 60_000, cacheScope: 'private' })
		const client = clientFor(server)
		await client.connect()
		await client.listTools({ bearerToken: 'alice' })
		await client.listTools({ bearerToken: 'alice' })
		expect(server.requestsFor('tools/list')).toHaveLength(1)
		await client.listTools({ bearerToken: 'bob' })
		expect(server.requestsFor('tools/list')).toHaveLength(2)
		await client.disconnect()
	})

	it('shares a public result between credentials', async () => {
		const server = toolsServer('newest', { ttlMs: 60_000, cacheScope: 'public' })
		const client = clientFor(server)
		await client.connect()
		await client.listTools({ bearerToken: 'alice' })
		await client.listTools({ bearerToken: 'bob' })
		expect(server.requestsFor('tools/list')).toHaveLength(1)
		await client.disconnect()
	})

	it('treats a result that is not complete as not cacheable', async () => {
		const server = toolsServer('newest', {
			ttlMs: 60_000,
			cacheScope: 'public',
			resultType: 'input_required',
		})
		const client = clientFor(server)
		await client.connect()
		await client.listTools()
		await client.listTools()
		expect(server.requestsFor('tools/list')).toHaveLength(2)
		await client.disconnect()
	})

	it('forgets everything on a new connection', async () => {
		const server = toolsServer('newest', { ttlMs: 60_000, cacheScope: 'public' })
		const client = clientFor(server)
		await client.connect()
		await client.listTools()
		await client.disconnect()
		await client.connect()
		await client.listTools()
		expect(server.requestsFor('tools/list')).toHaveLength(2)
		await client.disconnect()
	})

	it('never caches against a server of the previous revision, whatever the result says', async () => {
		const server = toolsServer('previous', { ttlMs: 60_000, cacheScope: 'public' })
		const client = clientFor(server)
		await client.connect()
		await client.listTools()
		await client.listTools()
		expect(server.requestsFor('tools/list')).toHaveLength(2)
		await client.disconnect()
	})
})
