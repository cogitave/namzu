import type { ToolContext } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createWebSearchTool, resolveWebSearch, webSearchLabel } from './search.js'

const clients: {
	connect: ReturnType<typeof vi.fn>
	disconnect: ReturnType<typeof vi.fn>
	callTool: ReturnType<typeof vi.fn>
}[] = []
vi.mock('@namzu/sdk', async (load) => {
	const actual = await load<typeof import('@namzu/sdk')>()
	return {
		...actual,
		MCPClient: class {
			connect = vi.fn(async () => ({}))
			disconnect = vi.fn(async () => {})
			callTool = vi.fn(async () => ({
				content: [
					{
						type: 'text',
						text: 'Title: Docs\nURL: https://example.com/docs\nText: source excerpt',
					},
				],
			}))
			constructor() {
				clients.push(this)
			}
		},
	}
})

function context(signal = new AbortController().signal): ToolContext {
	return {
		abortSignal: signal,
		workingDirectory: '/work',
		env: {},
		log: () => {},
	} as unknown as ToolContext
}

describe('model-independent web search', () => {
	it('defaults to Exa and keeps explicit native and off settings distinct', () => {
		expect(resolveWebSearch()).toEqual({ backend: 'exa', mode: 'live' })
		expect(webSearchLabel()).toBe('On · Exa')
		expect(resolveWebSearch(undefined, true)).toEqual({ backend: 'native', mode: 'live' })
		expect(resolveWebSearch({ backend: 'exa' }, true)).toEqual({ backend: 'exa', mode: 'live' })
		expect(webSearchLabel({ search: 'off' })).toBe('Off')
		expect(resolveWebSearch({ backend: 'native' })).toEqual({ backend: 'native', mode: 'live' })
		expect(resolveWebSearch({ search: 'cached' })).toEqual({ backend: 'native', mode: 'cached' })
		expect(() => resolveWebSearch({ backend: 'exa', search: 'cached' })).toThrow(/cached|Cached/)
	})
	it('searches with isolated connections, preserves source content and always closes', async () => {
		clients.length = 0
		const tool = createWebSearchTool()
		expect(tool.category).toBe('network')
		const results = await Promise.all([
			tool.execute({ query: 'docs', limit: 2 }, context()),
			tool.execute({ query: 'other' }, context()),
		])
		expect(clients).toHaveLength(2)
		expect(clients[0]?.callTool).toHaveBeenCalledWith(
			'web_search_exa',
			expect.objectContaining({ query: 'docs', numResults: 2 }),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		for (const client of clients) expect(client.disconnect).toHaveBeenCalledOnce()
		expect(results[0]?.success).toBe(true)
		expect(results[0]?.output).toContain('https://example.com/docs')
		expect(results[0]?.output).toContain('namzu-untrusted')
	})
	it('does not connect after cancellation', async () => {
		clients.length = 0
		const abort = new AbortController()
		abort.abort(new Error('stopped'))
		await expect(
			createWebSearchTool().execute({ query: 'docs' }, context(abort.signal)),
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('stopped') })
		expect(clients).toHaveLength(0)
	})
	it('reports service errors and closes the connection', async () => {
		clients.length = 0
		const pending = createWebSearchTool().execute({ query: 'docs' }, context())
		clients[0]?.callTool.mockRejectedValueOnce(new Error('rate limited'))
		expect(await pending).toMatchObject({
			success: false,
			error: expect.stringContaining('rate limited'),
		})
		expect(clients[0]?.disconnect).toHaveBeenCalledOnce()
	})
	it('does not start a search when cancelled while connecting', async () => {
		clients.length = 0
		const abort = new AbortController()
		const pending = createWebSearchTool().execute({ query: 'docs' }, context(abort.signal))
		abort.abort(new Error('stopped during connection'))
		expect(await pending).toMatchObject({ success: false })
		expect(clients[0]?.callTool).not.toHaveBeenCalled()
		expect(clients[0]?.disconnect).toHaveBeenCalled()
	})
})
