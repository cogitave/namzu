import { describe, expect, it } from 'vitest'
import { clientFor, fakeMcpServer } from '../__fixtures__/fake-mcp-server.js'

const tool = (name: string) => ({ name, inputSchema: { type: 'object' } })

describe('the order of a tool list', () => {
	for (const revision of ['newest', 'previous'] as const) {
		it(`is the same on every request whatever order a ${revision} server sends`, async () => {
			const orders = [
				['zeta', 'alpha', 'Mid', 'beta'],
				['beta', 'Mid', 'zeta', 'alpha'],
			]
			let call = 0
			const server = fakeMcpServer({
				revision,
				handlers: {
					'tools/list': () => ({
						result: { resultType: 'complete', tools: (orders[call++ % 2] ?? []).map(tool) },
					}),
				},
			})
			const client = clientFor(server)
			await client.connect()
			const first = (await client.listTools()).map((t) => t.name)
			const second = (await client.listTools()).map((t) => t.name)
			expect(first).toEqual(['Mid', 'alpha', 'beta', 'zeta'])
			expect(second).toEqual(first)
			await client.disconnect()
		})
	}
})
