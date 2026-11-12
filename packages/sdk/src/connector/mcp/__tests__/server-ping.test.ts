import { describe, expect, it } from 'vitest'
import { clientFor, fakeMcpServer } from '../__fixtures__/fake-mcp-server.js'

describe('a ping from the server', () => {
	it('is answered with an empty result by a connection to the previous revision', async () => {
		const server = fakeMcpServer({ revision: 'previous' })
		const client = clientFor(server)
		await client.connect()
		server.push({ jsonrpc: '2.0', id: 'p1', method: 'ping' })
		await Promise.resolve()
		const reply = server.sent.find((m) => m.id === 'p1')
		expect(reply?.result).toEqual({})
		expect(reply?.error).toBeUndefined()
		await client.disconnect()
	})

	it('is still declined on the newest revision, which has no ping', async () => {
		const server = fakeMcpServer({ revision: 'newest' })
		const client = clientFor(server)
		await client.connect()
		server.push({ jsonrpc: '2.0', id: 'p1', method: 'ping' })
		await Promise.resolve()
		expect(server.sent.find((m) => m.id === 'p1')?.error?.code).toBe(-32601)
		await client.disconnect()
	})
})
