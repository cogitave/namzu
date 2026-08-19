import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MCPTransport } from '../../../types/connector/index.js'
import type { MCPTransportUnion } from '../../../types/connector/index.js'
import { MCPClient } from '../client.js'
import { HttpSseTransport } from '../http-sse.js'
import { StdioTransport } from '../stdio.js'
import { StreamableHttpTransport } from '../streamable-http.js'

afterEach(() => {
	vi.unstubAllGlobals()
})

const MESSAGE = {
	jsonrpc: '2.0' as const,
	id: 7,
	method: 'tools/call',
	params: {},
}

function rejectOnAbort(signal: AbortSignal | null | undefined): Promise<Response> {
	return new Promise((_resolve, reject) => {
		signal?.addEventListener(
			'abort',
			() =>
				reject(
					Object.assign(new Error('generic fetch abort'), {
						name: 'AbortError',
					}),
				),
			{ once: true },
		)
	})
}

async function abortPendingSend(
	transport: MCPTransport,
	started: Promise<void>,
	caller: AbortController,
	reason: Error,
): Promise<void> {
	const pending = transport.send(MESSAGE, { signal: caller.signal })
	await started
	caller.abort(reason)
	await expect(pending).rejects.toBe(reason)
}

describe('MCP HTTP transports retain one send operation authority', () => {
	it('aborts a pending Streamable HTTP fetch without failing the shared transport', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let privateSignal: AbortSignal | undefined
		vi.stubGlobal(
			'fetch',
			vi.fn((_input: string, init: RequestInit) => {
				privateSignal = init.signal as AbortSignal
				markStarted()
				return rejectOnAbort(privateSignal)
			}),
		)
		const transport = new StreamableHttpTransport({
			type: 'streamable-http',
			url: 'https://mcp.example.test/rpc',
			timeoutMs: 60_000,
		})
		const transportErrors = vi.fn()
		transport.onError(transportErrors)
		await transport.connect()
		const caller = new AbortController()
		const reason = new Error('caller stopped streamable send')

		await abortPendingSend(transport, started, caller, reason)

		expect(privateSignal).toBeDefined()
		expect(privateSignal).not.toBe(caller.signal)
		expect(privateSignal?.reason).toBe(reason)
		expect(transportErrors).not.toHaveBeenCalled()
	})

	it('aborts a pending Streamable HTTP body read with the same cause', async () => {
		let markBodyStarted!: () => void
		const bodyStarted = new Promise<void>((resolve) => {
			markBodyStarted = resolve
		})
		let privateSignal: AbortSignal | undefined
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_input: string, init: RequestInit) => {
				privateSignal = init.signal as AbortSignal
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					headers: new Headers({ 'content-type': 'application/json' }),
					text: () => {
						markBodyStarted()
						return new Promise<string>(() => {})
					},
				} as Response
			}),
		)
		const transport = new StreamableHttpTransport({
			type: 'streamable-http',
			url: 'https://mcp.example.test/rpc',
			timeoutMs: 60_000,
		})
		await transport.connect()
		const caller = new AbortController()
		const reason = new Error('caller stopped streamable body')

		await abortPendingSend(transport, bodyStarted, caller, reason)

		expect(privateSignal?.aborted).toBe(true)
		expect(privateSignal?.reason).toBe(reason)
	})

	it('aborts a pending HTTP-SSE POST without closing its shared event stream', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let privateSignal: AbortSignal | undefined
		vi.stubGlobal(
			'fetch',
			vi.fn((input: string | URL | Request, init?: RequestInit) => {
				if (String(input).endsWith('/sse')) {
					return Promise.resolve(new Response(new ReadableStream()))
				}
				privateSignal = init?.signal as AbortSignal
				markStarted()
				return rejectOnAbort(privateSignal)
			}),
		)
		const transport = new HttpSseTransport({
			type: 'http-sse',
			url: 'https://mcp.example.test',
			timeoutMs: 60_000,
		})
		await transport.connect()
		const caller = new AbortController()
		const reason = new Error('caller stopped SSE POST')

		await abortPendingSend(transport, started, caller, reason)

		expect(privateSignal).not.toBe(caller.signal)
		expect(privateSignal?.reason).toBe(reason)
		expect(transport.isConnected()).toBe(true)
		await transport.close()
	})

	it('aborts a pending HTTP-SSE JSON body read with the same cause', async () => {
		let markBodyStarted!: () => void
		const bodyStarted = new Promise<void>((resolve) => {
			markBodyStarted = resolve
		})
		let privateSignal: AbortSignal | undefined
		vi.stubGlobal(
			'fetch',
			vi.fn((input: string | URL | Request, init?: RequestInit) => {
				if (String(input).endsWith('/sse')) {
					return Promise.resolve(new Response(new ReadableStream()))
				}
				privateSignal = init?.signal as AbortSignal
				return Promise.resolve({
					ok: true,
					status: 200,
					statusText: 'OK',
					headers: new Headers({ 'content-type': 'application/json' }),
					json: () => {
						markBodyStarted()
						return new Promise<never>(() => {})
					},
				} as unknown as Response)
			}),
		)
		const transport = new HttpSseTransport({
			type: 'http-sse',
			url: 'https://mcp.example.test',
			timeoutMs: 60_000,
		})
		await transport.connect()
		const caller = new AbortController()
		const reason = new Error('caller stopped SSE body')

		await abortPendingSend(transport, bodyStarted, caller, reason)

		expect(privateSignal?.aborted).toBe(true)
		expect(privateSignal?.reason).toBe(reason)
		await transport.close()
	})

	it('starts no Streamable HTTP fetch for a pre-aborted send', async () => {
		const fetchMock = vi.fn<typeof fetch>()
		vi.stubGlobal('fetch', fetchMock)
		const transport = new StreamableHttpTransport({
			type: 'streamable-http',
			url: 'https://mcp.example.test/rpc',
		})
		await transport.connect()
		const caller = new AbortController()
		const reason = new Error('already stopped')
		caller.abort(reason)

		await expect(transport.send(MESSAGE, { signal: caller.signal })).rejects.toBe(reason)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('writes no stdio bytes for a pre-aborted send', async () => {
		const transport = new StdioTransport({ type: 'stdio', command: 'unused' })
		const write = vi.fn()
		;(
			transport as unknown as { process: { stdin: { writable: boolean; write: typeof write } } }
		).process = { stdin: { writable: true, write } }
		const caller = new AbortController()
		const reason = new Error('already stopped')
		caller.abort(reason)

		await expect(transport.send(MESSAGE, { signal: caller.signal })).rejects.toBe(reason)
		expect(write).not.toHaveBeenCalled()
	})

	it('does not let a failed cancellation POST reject a concurrent sibling request', async () => {
		let resolveB!: (response: Response) => void
		let markBothStarted!: () => void
		const bothStarted = new Promise<void>((resolve) => {
			markBothStarted = resolve
		})
		let toolStarts = 0
		const fetchMock = vi.fn((_: string | URL | Request, init?: RequestInit) => {
			const message = JSON.parse(String(init?.body)) as {
				id?: string | number
				method?: string
				params?: { name?: string }
			}
			if (message.method === 'initialize') {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							jsonrpc: '2.0',
							id: message.id,
							result: {
								protocolVersion: '2024-11-05',
								serverInfo: { name: 'fixture' },
								capabilities: { tools: {} },
							},
						}),
						{ headers: { 'content-type': 'application/json' } },
					),
				)
			}
			if (message.method === 'notifications/initialized') {
				return Promise.resolve(new Response(null, { status: 204 }))
			}
			if (message.method === 'notifications/cancelled') {
				return Promise.resolve(new Response('cancel failed', { status: 500 }))
			}
			toolStarts++
			if (toolStarts === 2) markBothStarted()
			if (message.params?.name === 'A') return rejectOnAbort(init?.signal)
			return new Promise<Response>((resolve) => {
				resolveB = resolve
			})
		})
		vi.stubGlobal('fetch', fetchMock)
		const client = new MCPClient({
			serverName: 'fixture',
			requestTimeoutMs: 60_000,
			transport: {
				type: 'streamable-http',
				url: 'https://mcp.example.test/rpc',
				timeoutMs: 60_000,
			} as MCPTransportUnion,
		})
		await client.connect()
		const callerA = new AbortController()
		const callA = client.callTool('A', {}, { signal: callerA.signal })
		const callB = client.callTool('B')
		await bothStarted

		const reason = new Error('cancel only A')
		callerA.abort(reason)
		await expect(callA).rejects.toBe(reason)
		await vi.waitFor(() => {
			expect(
				fetchMock.mock.calls.some(([, init]) =>
					String(init?.body).includes('notifications/cancelled'),
				),
			).toBe(true)
		})
		const requestB = fetchMock.mock.calls
			.map(
				([, init]) => JSON.parse(String(init?.body)) as { id?: string | number; params?: unknown },
			)
			.find((message) => (message.params as { name?: string } | undefined)?.name === 'B')
		resolveB(
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: requestB?.id,
					result: { content: [{ type: 'text', text: 'B survived' }] },
				}),
				{ headers: { 'content-type': 'application/json' } },
			),
		)

		await expect(callB).resolves.toEqual({
			content: [{ type: 'text', text: 'B survived' }],
		})
		expect(client.getState().status).toBe('connected')
		expect(
			(client as unknown as { pendingRequests: Map<unknown, unknown> }).pendingRequests.size,
		).toBe(0)
	})

	it('turns a shorter transport deadline into correlated protocol cancellation', async () => {
		const frames: Array<{
			id?: string | number
			method?: string
			params?: Record<string, unknown>
		}> = []
		const fetchMock = vi.fn((_: string | URL | Request, init?: RequestInit) => {
			const message = JSON.parse(String(init?.body)) as {
				id?: string | number
				method?: string
				params?: Record<string, unknown>
			}
			frames.push(message)
			if (message.method === 'initialize') {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							jsonrpc: '2.0',
							id: message.id,
							result: {
								protocolVersion: '2024-11-05',
								serverInfo: { name: 'fixture' },
								capabilities: { tools: {} },
							},
						}),
						{ headers: { 'content-type': 'application/json' } },
					),
				)
			}
			if (
				message.method === 'notifications/initialized' ||
				message.method === 'notifications/cancelled'
			) {
				return Promise.resolve(new Response(null, { status: 204 }))
			}
			return new Promise<Response>(() => {})
		})
		vi.stubGlobal('fetch', fetchMock)
		const client = new MCPClient({
			serverName: 'fixture',
			requestTimeoutMs: 60_000,
			transport: {
				type: 'streamable-http',
				url: 'https://mcp.example.test/rpc',
				timeoutMs: 5,
			} as MCPTransportUnion,
		})
		await client.connect()

		const error = await client.callTool('slow').catch((caught: unknown) => caught)
		await vi.waitFor(() => {
			expect(frames.some((frame) => frame.method === 'notifications/cancelled')).toBe(true)
		})

		expect(error).toBeInstanceOf(Error)
		expect((error as Error).name).toBe('TimeoutError')
		expect((error as Error).message).toContain('timed out after 5ms')
		const request = frames.find((frame) => frame.method === 'tools/call')
		const cancellation = frames.find((frame) => frame.method === 'notifications/cancelled')
		expect(cancellation?.params).toEqual({
			requestId: request?.id,
			reason: 'Request deadline expired',
		})
		expect(
			(client as unknown as { pendingRequests: Map<unknown, unknown> }).pendingRequests.size,
		).toBe(0)
	})

	it('does not dispatch an old HTTP-SSE POST response into reconnected handlers', async () => {
		let resolveOldPost!: (response: Response) => void
		const sseStreams: ReadableStream<Uint8Array>[] = [new ReadableStream(), new ReadableStream()]
		let sseIndex = 0
		vi.stubGlobal(
			'fetch',
			vi.fn((input: string | URL | Request) => {
				if (String(input).endsWith('/sse')) {
					return Promise.resolve(new Response(sseStreams[sseIndex++]))
				}
				return new Promise<Response>((resolve) => {
					resolveOldPost = resolve
				})
			}),
		)
		const transport = new HttpSseTransport({
			type: 'http-sse',
			url: 'https://mcp.example.test',
		})
		await transport.connect()
		const oldSend = transport.send(MESSAGE)
		await transport.close()
		await expect(oldSend).rejects.toThrow('HttpSseTransport closed')
		await transport.connect()
		const newHandler = vi.fn()
		transport.onMessage(newHandler)

		resolveOldPost(
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					method: 'notifications/progress',
					params: { stale: true },
				}),
				{ headers: { 'content-type': 'application/json' } },
			),
		)
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(newHandler).not.toHaveBeenCalled()
		await transport.close()
	})

	it('stops HTTP-SSE POST dispatch when its first handler reconnects', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn((input: string | URL | Request) => {
				if (String(input).endsWith('/sse')) {
					return Promise.resolve(new Response(new ReadableStream()))
				}
				return Promise.resolve(
					new Response(
						JSON.stringify({
							jsonrpc: '2.0',
							method: 'notifications/progress',
							params: {},
						}),
						{ headers: { 'content-type': 'application/json' } },
					),
				)
			}),
		)
		const transport = new HttpSseTransport({
			type: 'http-sse',
			url: 'https://mcp.example.test',
		})
		await transport.connect()
		const newHandler = vi.fn()
		const firstOldHandler = vi.fn(() => {
			void transport.close()
			void transport.connect()
			transport.onMessage(newHandler)
		})
		const secondOldHandler = vi.fn()
		transport.onMessage(firstOldHandler)
		transport.onMessage(secondOldHandler)

		await expect(transport.send(MESSAGE)).rejects.toThrow('HttpSseTransport closed')

		expect(firstOldHandler).toHaveBeenCalledOnce()
		expect(secondOldHandler).not.toHaveBeenCalled()
		expect(newHandler).not.toHaveBeenCalled()
		await transport.close()
	})

	it('does not dispatch an old Streamable POST response into reconnected handlers', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let resolveOldPost!: (response: Response) => void
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				markStarted()
				return new Promise<Response>((resolve) => {
					resolveOldPost = resolve
				})
			}),
		)
		const transport = new StreamableHttpTransport({
			type: 'streamable-http',
			url: 'https://mcp.example.test/rpc',
		})
		await transport.connect()
		const oldSend = transport.send(MESSAGE)
		await started
		await transport.close()
		await expect(oldSend).rejects.toThrow('StreamableHttpTransport closed')
		await transport.connect()
		const newHandler = vi.fn()
		transport.onMessage(newHandler)

		resolveOldPost(
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					method: 'notifications/progress',
					params: { stale: true },
				}),
				{ headers: { 'content-type': 'application/json' } },
			),
		)
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(newHandler).not.toHaveBeenCalled()
		await transport.close()
	})

	it('does not dispatch an old HTTP-SSE stream event after reconnect', async () => {
		let oldStream!: ReadableStreamDefaultController<Uint8Array>
		const oldBody = new ReadableStream<Uint8Array>({
			start(controller) {
				oldStream = controller
			},
		})
		const newBody = new ReadableStream<Uint8Array>()
		let sseIndex = 0
		vi.stubGlobal(
			'fetch',
			vi.fn((input: string | URL | Request) => {
				if (!String(input).endsWith('/sse')) {
					return Promise.resolve(new Response(null, { status: 204 }))
				}
				return Promise.resolve(new Response(sseIndex++ === 0 ? oldBody : newBody))
			}),
		)
		const transport = new HttpSseTransport({
			type: 'http-sse',
			url: 'https://mcp.example.test',
		})
		await transport.connect()
		await transport.close()
		await transport.connect()
		const newHandler = vi.fn()
		transport.onMessage(newHandler)

		oldStream.enqueue(
			new TextEncoder().encode(
				`data: ${JSON.stringify({
					jsonrpc: '2.0',
					method: 'notifications/progress',
					params: { stale: true },
				})}\n\n`,
			),
		)
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(newHandler).not.toHaveBeenCalled()
		await transport.close()
	})

	it('stops a Streamable response batch when its first handler reconnects', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify([
							{
								jsonrpc: '2.0',
								method: 'notifications/first',
								params: {},
							},
							{
								jsonrpc: '2.0',
								method: 'notifications/stale_second',
								params: {},
							},
						]),
						{ headers: { 'content-type': 'application/json' } },
					),
			),
		)
		const transport = new StreamableHttpTransport({
			type: 'streamable-http',
			url: 'https://mcp.example.test/rpc',
		})
		await transport.connect()
		const oldSeen: string[] = []
		const newHandler = vi.fn()
		transport.onMessage((message) => {
			oldSeen.push(message.method ?? '')
			void transport.close()
			void transport.connect()
			transport.onMessage(newHandler)
		})

		await expect(transport.send(MESSAGE)).rejects.toThrow('StreamableHttpTransport closed')

		expect(oldSeen).toEqual(['notifications/first'])
		expect(newHandler).not.toHaveBeenCalled()
		await transport.close()
	})

	it('stops an HTTP-SSE event batch when its first handler reconnects', async () => {
		let resolveOldSse!: (response: Response) => void
		let sseCalls = 0
		vi.stubGlobal(
			'fetch',
			vi.fn((input: string | URL | Request) => {
				if (!String(input).endsWith('/sse')) {
					return Promise.resolve(new Response(null, { status: 204 }))
				}
				sseCalls++
				if (sseCalls === 1) {
					return new Promise<Response>((resolve) => {
						resolveOldSse = resolve
					})
				}
				return Promise.resolve(new Response(new ReadableStream()))
			}),
		)
		const transport = new HttpSseTransport({
			type: 'http-sse',
			url: 'https://mcp.example.test',
		})
		await transport.connect()
		const oldSeen: string[] = []
		const newHandler = vi.fn()
		transport.onMessage((message) => {
			oldSeen.push(message.method ?? '')
			void transport.close()
			void transport.connect()
			transport.onMessage(newHandler)
		})
		resolveOldSse(
			new Response(
				[
					{
						jsonrpc: '2.0',
						method: 'notifications/first',
						params: {},
					},
					{
						jsonrpc: '2.0',
						method: 'notifications/stale_second',
						params: {},
					},
				]
					.map((message) => `data: ${JSON.stringify(message)}\n\n`)
					.join(''),
			),
		)
		await vi.waitFor(() => expect(oldSeen).toEqual(['notifications/first']))

		expect(newHandler).not.toHaveBeenCalled()
		await transport.close()
	})

	it.each([
		[
			() =>
				new StreamableHttpTransport({ type: 'streamable-http', url: 'https://x', timeoutMs: 0 }),
		],
		[() => new HttpSseTransport({ type: 'http-sse', url: 'https://x', timeoutMs: 1.5 })],
	])('refuses an invalid HTTP transport deadline at construction', (construct) => {
		expect(construct).toThrow(/timeoutMs must be an integer from 1/)
	})
})
