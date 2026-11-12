import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientFor, fakeMcpServer } from '../__fixtures__/fake-mcp-server.js'

const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId'
const URI = 'file:///project/config.json'
const never = () => new Promise<never>(() => {})

describe('subscribing to one resource', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('on the newest revision asks the one listen stream for it, and delivers the update', async () => {
		const server = fakeMcpServer({
			revision: 'newest',
			capabilities: { resources: { subscribe: true } },
			handlers: { 'subscriptions/listen': never },
		})
		const client = clientFor(server)
		await client.connect()
		// Nothing to listen for yet: no stream is opened.
		expect(server.methods()).not.toContain('subscriptions/listen')

		const updates: Array<Record<string, unknown> | undefined> = []
		client.onNotification((method, params) => {
			if (method === 'notifications/resources/updated') updates.push(params)
		})
		expect(await client.subscribeResource(URI)).toBe(true)

		const [listen] = server.requestsFor('subscriptions/listen')
		expect(listen?.params?.notifications).toEqual({ resourceSubscriptions: [URI] })
		expect(server.methods()).not.toContain('resources/subscribe')

		server.push({
			jsonrpc: '2.0',
			method: 'notifications/subscriptions/acknowledged',
			params: {
				_meta: { [SUBSCRIPTION_ID]: listen?.id },
				notifications: { resourceSubscriptions: [URI] },
			},
		})
		server.push({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { _meta: { [SUBSCRIPTION_ID]: listen?.id }, uri: URI },
		})
		// A resource nobody asked for is dropped even on the right stream.
		server.push({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { _meta: { [SUBSCRIPTION_ID]: listen?.id }, uri: 'file:///other' },
		})
		expect(updates).toHaveLength(1)
		expect(updates[0]?.uri).toBe(URI)
		await client.disconnect()
	})

	it('on the newest revision reopens the stream when the set changes and closes it when empty', async () => {
		const server = fakeMcpServer({
			revision: 'newest',
			capabilities: { resources: { subscribe: true } },
			handlers: { 'subscriptions/listen': never },
		})
		const client = clientFor(server)
		await client.connect()
		await client.subscribeResource(URI)
		await client.subscribeResource('file:///two')
		await vi.advanceTimersByTimeAsync(0)
		const listens = server.requestsFor('subscriptions/listen')
		expect(listens).toHaveLength(2)
		expect(listens[1]?.params?.notifications).toEqual({
			resourceSubscriptions: [URI, 'file:///two'],
		})
		// The first stream was cancelled; a new request id carries the new filter.
		expect(listens[1]?.id).not.toBe(listens[0]?.id)
		expect(server.sent.filter((m) => m.method === 'notifications/cancelled')).toHaveLength(1)
		await client.unsubscribeResource(URI)
		await client.unsubscribeResource('file:///two')
		await vi.advanceTimersByTimeAsync(0)
		expect(server.requestsFor('subscriptions/listen')).toHaveLength(2)
		await client.disconnect()
	})

	it('on the previous revision uses resources/subscribe and asks again after a reconnection', async () => {
		const server = fakeMcpServer({
			revision: 'previous',
			capabilities: { resources: { subscribe: true } },
			handlers: {
				'resources/subscribe': () => ({ result: {} }),
				'resources/unsubscribe': () => ({ result: {} }),
			},
		})
		const client = clientFor(server)
		await client.connect()
		const updates: string[] = []
		client.onNotification((method, params) => {
			if (method === 'notifications/resources/updated') updates.push(String(params?.uri))
		})
		expect(await client.subscribeResource(URI)).toBe(true)
		expect(server.requestsFor('resources/subscribe').map((m) => m.params)).toEqual([{ uri: URI }])
		expect(server.methods()).not.toContain('subscriptions/listen')
		server.push({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: URI } })
		expect(updates).toEqual([URI])

		await client.disconnect()
		await client.connect()
		expect(server.requestsFor('resources/subscribe')).toHaveLength(2)

		await client.unsubscribeResource(URI)
		expect(server.requestsFor('resources/unsubscribe').map((m) => m.params)).toEqual([{ uri: URI }])
		await client.disconnect()
	})

	it('sends nothing when the server does not advertise subscribe', async () => {
		for (const revision of ['newest', 'previous'] as const) {
			const server = fakeMcpServer({ revision, capabilities: { resources: {} } })
			const client = clientFor(server)
			await client.connect()
			expect(await client.subscribeResource(URI)).toBe(false)
			expect(server.methods()).not.toContain('resources/subscribe')
			expect(server.methods()).not.toContain('subscriptions/listen')
			await client.disconnect()
		}
	})
})
