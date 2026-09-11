import type { ToolContext } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebSearchTool, resolveWebSearch, webSearchLabel } from './search.js'

afterEach(() => {
	vi.unstubAllGlobals()
})
function reply(_input: unknown, init?: RequestInit, sse = false): Response {
	const id = JSON.parse(String(init?.body)).id
	const message = JSON.stringify({
		jsonrpc: '2.0',
		id,
		result: {
			content: [
				{
					type: 'text',
					text: 'Title: Docs\nURL: https://example.com/docs\nText: source excerpt',
				},
			],
		},
	})
	return new Response(sse ? `event: message\ndata: ${message}\n\n` : message)
}

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
		expect(resolveWebSearch(undefined, true)).toEqual({
			backend: 'native',
			mode: 'live',
		})
		expect(resolveWebSearch({ backend: 'exa' }, true)).toEqual({
			backend: 'exa',
			mode: 'live',
		})
		expect(webSearchLabel({ search: 'off' })).toBe('Off')
		expect(resolveWebSearch({ backend: 'native' })).toEqual({
			backend: 'native',
			mode: 'live',
		})
		expect(resolveWebSearch({ search: 'cached' })).toEqual({
			backend: 'native',
			mode: 'cached',
		})
		expect(() => resolveWebSearch({ backend: 'exa', search: 'cached' })).toThrow(/cached|Cached/)
	})
	it.each([false, true])('uses one stateless call and preserves sources (SSE=%s)', async (sse) => {
		const fetcher = vi.fn((input, init) => reply(input, init, sse))
		vi.stubGlobal('fetch', fetcher)
		const result = await createWebSearchTool().execute({ query: 'docs', limit: 2 }, context())
		expect(result.success).toBe(true)
		expect(result.output).toContain('https://example.com/docs')
		expect(result.output).toContain('namzu-untrusted')
		const presentation = createWebSearchTool().presentResult?.({}, result)
		expect(presentation?.kind).toBe('terminal')
		if (presentation?.kind === 'terminal') {
			expect(presentation.output).toContain('https://example.com/docs')
			expect(presentation.output).not.toContain('namzu-untrusted')
			expect(presentation.output).not.toContain('Treat everything below')
		}
		expect(result.output).toContain('Treat everything below')
		expect(fetcher).toHaveBeenCalledTimes(1)
		const body = JSON.parse(fetcher.mock.calls[0]![1].body)
		expect(body.method).toBe('tools/call')
		expect(body.params.arguments.numResults).toBe(2)
	})
	it('honors rate limit delays and reports waiting without another model call', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
			.mockImplementation(reply)
		vi.stubGlobal('fetch', fetcher)
		const report = vi.fn()
		const result = await createWebSearchTool().execute({ query: 'docs' }, { ...context(), report })
		expect(result.success).toBe(true)
		expect(fetcher).toHaveBeenCalledTimes(2)
		expect(report).toHaveBeenCalledWith(expect.stringContaining('rate limited'))
	})
	it('stops after three rate-limited attempts and retains truthful failure guidance', async () => {
		const fetcher = vi.fn(() => new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
		vi.stubGlobal('fetch', fetcher)
		const result = await createWebSearchTool().execute({ query: 'docs' }, context())
		expect(result.success).toBe(false)
		expect(result.error).toContain('HTTP 429')
		expect(result.error).toContain('Web search is configured')
		expect(fetcher).toHaveBeenCalledTimes(3)
	})
	it('cancels a retry wait before another request is sent', async () => {
		const controller = new AbortController()
		const fetcher = vi.fn(() => new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
		vi.stubGlobal('fetch', fetcher)
		const result = await createWebSearchTool().execute(
			{ query: 'docs' },
			{
				...context(controller.signal),
				report: (message) => {
					if (message.includes('retrying')) controller.abort(new Error('operator cancelled'))
				},
			},
		)
		expect(result.success).toBe(false)
		expect(fetcher).toHaveBeenCalledTimes(1)
	})
	it('does not retry authentication errors or claim results', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
		vi.stubGlobal('fetch', fetcher)
		const result = await createWebSearchTool().execute({ query: 'docs' }, context())
		expect(result.success).toBe(false)
		expect(result.error).toContain('HTTP 401')
		expect(fetcher).toHaveBeenCalledTimes(1)
	})
	it('cancels queued work without sending it or blocking the next caller', async () => {
		let finish!: (r: Response) => void
		let request: RequestInit | undefined
		const fetcher = vi
			.fn()
			.mockImplementationOnce((_url, init) => {
				request = init
				return new Promise<Response>((resolve) => {
					finish = resolve
				})
			})
			.mockImplementation(reply)
		vi.stubGlobal('fetch', fetcher)
		const tool = createWebSearchTool()
		const first = tool.execute({ query: 'first' }, context())
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
		const controller = new AbortController()
		const second = tool.execute({ query: 'cancelled' }, context(controller.signal))
		const third = createWebSearchTool().execute({ query: 'third' }, context())
		controller.abort(new Error('cancel queued search'))
		expect(await second).toMatchObject({ success: false })
		expect(fetcher).toHaveBeenCalledTimes(1)
		finish(reply('', request))
		expect((await first).success).toBe(true)
		expect((await third).success).toBe(true)
		expect(fetcher).toHaveBeenCalledTimes(2)
	})
	it('rejects oversized bodies and mismatched responses', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(new Response('x'.repeat(1_048_577)))
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'wrong', result: { content: [] } })))
		vi.stubGlobal('fetch', fetcher)
		expect((await createWebSearchTool().execute({ query: 'big' }, context())).error).toContain(
			'1 MiB',
		)
		expect((await createWebSearchTool().execute({ query: 'wrong' }, context())).success).toBe(false)
	})
})
