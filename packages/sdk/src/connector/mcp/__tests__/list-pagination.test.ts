import { describe, expect, it, vi } from 'vitest'

import { MCPClient } from '../client.js'

/**
 * The three list calls sent an empty params object and returned the first
 * page — no cursor out, no cursor read back. A server that pages its
 * catalogue therefore contributed only its first page: the rest were never
 * registered, never namespaced, never advertised to the model.
 *
 * Nothing said so. There is no error, no warning, and drift detection does
 * not help either, because it compares page one against page one. The
 * symptom is a model that never uses a tool it was told about, which reads
 * as model incompetence rather than a client bug.
 */

function pagedClient(pages: Array<{ tools: unknown[]; nextCursor?: string }>) {
	const cursors: Array<string | undefined> = []
	const client = new MCPClient({
		serverName: 'srv',
		transport: { type: 'stdio', command: '/bin/true' },
	})

	// The request layer is the seam; connecting a real server is not the
	// thing under test.
	let page = 0
	;(client as unknown as { connected: boolean }).connected = true
	;(client as unknown as { requireConnected: () => void }).requireConnected = () => {}
	;(client as unknown as { request: unknown }).request = vi.fn(
		async (_method: string, params: Record<string, unknown>) => {
			cursors.push(params.cursor as string | undefined)
			return pages[page++] ?? { tools: [] }
		},
	)

	return { client, cursors }
}

const named = (...names: string[]) => names.map((name) => ({ name, inputSchema: {} }))

describe('listing a paged catalogue', () => {
	it('reads every page, not just the first', async () => {
		const { client } = pagedClient([
			{ tools: named('a', 'b'), nextCursor: 'p2' },
			{ tools: named('c', 'd'), nextCursor: 'p3' },
			{ tools: named('e') },
		])

		const tools = await client.listTools()
		expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd', 'e'])
	})

	it('sends back the cursor it was given', async () => {
		const { client, cursors } = pagedClient([
			{ tools: named('a'), nextCursor: 'p2' },
			{ tools: named('b') },
		])

		await client.listTools()
		// The first request carries no cursor; each later one carries the
		// token the previous page returned.
		expect(cursors).toEqual([undefined, 'p2'])
	})

	it('stops at a page that returns no cursor', async () => {
		const { client, cursors } = pagedClient([{ tools: named('a') }])
		await client.listTools()
		expect(cursors).toHaveLength(1)
	})

	it('treats an empty cursor as the end rather than paging forever', async () => {
		const { client, cursors } = pagedClient([{ tools: named('a'), nextCursor: '' }])
		await client.listTools()
		expect(cursors).toHaveLength(1)
	})

	it('refuses a server whose cursor never ends', async () => {
		const endless = Array.from({ length: 200 }, () => ({
			tools: named('x'),
			nextCursor: 'more',
		}))
		const { client } = pagedClient(endless)

		// Looping until the process dies is worse than the truncation this
		// replaces, and stopping silently would BE that truncation.
		await expect(client.listTools()).rejects.toThrow(/did not stop paging/)
	})

	it('pages resources the same way', async () => {
		const { client } = pagedClient([
			{ tools: [], resources: [{ uri: 'a' }], nextCursor: 'p2' } as never,
			{ tools: [], resources: [{ uri: 'b' }] } as never,
		])

		const resources = await client.listResources()
		expect(resources.map((r) => r.uri)).toEqual(['a', 'b'])
	})
})
