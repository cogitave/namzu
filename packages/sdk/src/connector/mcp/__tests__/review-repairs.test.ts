import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientFor, fakeMcpServer } from '../__fixtures__/fake-mcp-server.js'

const EXT = 'io.modelcontextprotocol/tasks'
const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId'
const TASK = {
	taskId: 'T1',
	createdAt: '2026-11-12T00:00:00Z',
	lastUpdatedAt: '2026-11-12T00:00:00Z',
	ttlMs: 60_000,
	pollIntervalMs: 30_000,
}
const never = () => new Promise<never>(() => {})
const tool = (name: string) => ({ name, inputSchema: { type: 'object' } })

function taskServer(task: Record<string, unknown>) {
	return fakeMcpServer({
		revision: 'newest',
		capabilities: { extensions: { [EXT]: {} } },
		handlers: {
			'tools/call': () => ({ result: { resultType: 'task', status: 'working', ...TASK } }),
			'tasks/get': () => ({ result: { resultType: 'complete', ...TASK, ...task } }),
			'tasks/cancel': () => ({ result: { resultType: 'complete' } }),
		},
	})
}

describe('repairs after review', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	describe('a task wait', () => {
		it('ends at once on disconnect and leaves no timer behind', async () => {
			const server = taskServer({ status: 'working' })
			const client = clientFor(server)
			await client.connect()
			const call = client.callTool('slow', {})
			const outcome = expect(call).rejects.toThrow(/disconnecting/)
			await vi.advanceTimersByTimeAsync(10)
			await client.disconnect()
			await outcome
			expect(vi.getTimerCount()).toBe(0)
		})

		it('refuses a completed task that carries no result', async () => {
			const server = taskServer({ status: 'completed' })
			server.on('tools/call', () => ({
				result: { resultType: 'task', status: 'completed', ...TASK },
			}))
			const client = clientFor(server)
			await client.connect()
			await expect(client.callTool('slow', {})).rejects.toThrow(/completed without a result/)
			await client.disconnect()
		})

		it('reports a failure with no code in the server words', async () => {
			const server = taskServer({ status: 'failed', error: { message: 'boom' } })
			const client = clientFor(server)
			await client.connect()
			const call = client.callTool('slow', {})
			const outcome = expect(call).rejects.toThrow(/failed: boom/)
			await vi.advanceTimersByTimeAsync(30_000)
			await outcome
			await client.disconnect()
		})
	})

	describe('the cache', () => {
		it('hands out copies, so an edit by a caller does not reach the next caller', async () => {
			const server = fakeMcpServer({
				revision: 'newest',
				handlers: {
					'tools/list': () => ({
						result: {
							resultType: 'complete',
							tools: [tool('a')],
							ttlMs: 60_000,
							cacheScope: 'public',
						},
					}),
					'resources/read': () => ({
						result: {
							resultType: 'complete',
							contents: [{ uri: 'u', text: 'ok' }],
							ttlMs: 60_000,
							cacheScope: 'public',
						},
					}),
				},
			})
			const client = clientFor(server)
			await client.connect()
			for (let i = 0; i < 2; i++) {
				const tools = await client.listTools()
				;(tools[0] as { name: string }).name = 'MUTATED'
				const contents = await client.readResource('u')
				;(contents[0] as { text: string }).text = 'MUT'
			}
			expect((await client.listTools())[0]?.name).toBe('a')
			expect(((await client.readResource('u'))[0] as { text: string }).text).toBe('ok')
			expect(server.requestsFor('tools/list')).toHaveLength(1)
			await client.disconnect()
		})

		it('keeps nothing longer than an hour whatever ttlMs says', async () => {
			const server = fakeMcpServer({
				revision: 'newest',
				handlers: {
					'tools/list': () => ({
						result: {
							resultType: 'complete',
							tools: [tool('a')],
							ttlMs: 1e308,
							cacheScope: 'public',
						},
					}),
				},
			})
			const client = clientFor(server)
			await client.connect()
			await client.listTools()
			vi.setSystemTime(Date.now() + 3_600_001)
			await client.listTools()
			expect(server.requestsFor('tools/list')).toHaveLength(2)
			await client.disconnect()
		})

		it('does not store an answer that was overtaken by a change notification', async () => {
			let generation = 0
			const server = fakeMcpServer({
				revision: 'newest',
				capabilities: { tools: { listChanged: true } },
				handlers: {
					'subscriptions/listen': never,
					'tools/list': () => {
						const mine = ++generation
						if (mine === 1) {
							const [listen] = server.requestsFor('subscriptions/listen')
							server.push({
								jsonrpc: '2.0',
								method: 'notifications/tools/list_changed',
								params: { _meta: { [SUBSCRIPTION_ID]: listen?.id } },
							})
						}
						return {
							result: {
								resultType: 'complete',
								tools: [tool(`t${mine}`)],
								ttlMs: 60_000,
								cacheScope: 'public',
							},
						}
					},
				},
			})
			const client = clientFor(server)
			await client.connect()
			const [listen] = server.requestsFor('subscriptions/listen')
			server.push({
				jsonrpc: '2.0',
				method: 'notifications/subscriptions/acknowledged',
				params: {
					_meta: { [SUBSCRIPTION_ID]: listen?.id },
					notifications: { toolsListChanged: true },
				},
			})
			expect((await client.listTools()).map((t) => t.name)).toEqual(['t1'])
			expect((await client.listTools()).map((t) => t.name)).toEqual(['t2'])
			await client.disconnect()
		})
	})

	describe('resource subscriptions', () => {
		it('open the stream once for a burst of changes, and not at all when the set ends where it began', async () => {
			const server = fakeMcpServer({
				revision: 'newest',
				capabilities: { resources: { subscribe: true } },
				handlers: { 'subscriptions/listen': never },
			})
			const client = clientFor(server)
			await client.connect()
			await client.subscribeResource('keep')
			for (let i = 0; i < 50; i++) {
				await client.subscribeResource(`u${i}`)
				await client.unsubscribeResource(`u${i}`)
			}
			await vi.advanceTimersByTimeAsync(0)
			expect(server.requestsFor('subscriptions/listen')).toHaveLength(1)
			await client.disconnect()
		})
	})

	describe('the order of a tool list', () => {
		it('is left as an older server sent it', async () => {
			const server = fakeMcpServer({
				revision: 'previous',
				handlers: {
					'tools/list': () => ({ result: { tools: [tool('z'), tool('a')] } }),
				},
			})
			const client = clientFor(server)
			await client.connect()
			expect((await client.listTools()).map((t) => t.name)).toEqual(['z', 'a'])
			await client.disconnect()
		})
	})
})
