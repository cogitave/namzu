import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
	MCPJsonRpcMessage,
	MCPProgressUpdate,
	MCPTransport,
} from '../../../types/connector/index.js'
import { MCPClient } from '../client.js'
import { createMcpEraCache } from '../era.js'

const FIXTURE = fileURLToPath(new URL('../__fixtures__/progress-server.mjs', import.meta.url))

function progress(progressToken: string, value: unknown, extra: Record<string, unknown> = {}) {
	return {
		jsonrpc: '2.0' as const,
		method: 'notifications/progress',
		params: { progressToken, progress: value, ...extra },
	}
}

function scriptedClient(modern = false) {
	const sent: MCPJsonRpcMessage[] = []
	let receive: (message: MCPJsonRpcMessage) => void = () => {}
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		send: async (message) => {
			sent.push(message)
			if (message.method === 'server/discover') {
				receive({
					jsonrpc: '2.0',
					id: message.id,
					result: modern
						? {
								supportedVersions: ['2026-07-28'],
								capabilities: { tools: {} },
								_meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture' } },
							}
						: {},
				})
			} else if (message.method === 'initialize') {
				receive({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						protocolVersion: '2024-11-05',
						serverInfo: { name: 'fixture' },
						capabilities: { tools: {} },
					},
				})
			}
		},
		onMessage: (handler) => {
			receive = handler
		},
		onClose: () => {},
		onError: () => {},
	}
	const client = new MCPClient({
		serverName: 'fixture',
		transport: { type: 'stdio', command: 'unused' },
		eraCache: createMcpEraCache(),
	})
	;(client as unknown as { transport: MCPTransport }).transport = transport
	return { client, sent, receive: (message: MCPJsonRpcMessage) => receive(message) }
}

function token(message: MCPJsonRpcMessage): string {
	const value = (message.params?._meta as Record<string, unknown> | undefined)?.progressToken
	if (typeof value !== 'string') throw new Error('tool call omitted its progress token')
	return value
}

function reply(message: MCPJsonRpcMessage): MCPJsonRpcMessage {
	return { jsonrpc: '2.0', id: message.id, result: { content: [] } }
}

describe('MCP tool progress belongs to one active request', () => {
	it('keeps the progress token alongside modern request metadata', async () => {
		const h = scriptedClient(true)
		await h.client.connect()
		const updates: MCPProgressUpdate[] = []
		const result = h.client.callTool('modern', {}, { onProgress: (update) => updates.push(update) })
		const request = h.sent.find((message) => message.method === 'tools/call')
		if (!request) throw new Error('modern call was not sent')
		const meta = request.params?._meta as Record<string, unknown>
		expect(meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
		expect(meta.progressToken).toBe(token(request))
		h.receive(progress(token(request), 1))
		h.receive(reply(request))
		await result
		expect(updates).toEqual([{ progress: 1 }])
	})

	it('validates and bounds updates, then forgets callbacks on success and cancellation', async () => {
		const h = scriptedClient()
		await h.client.connect()
		h.sent.length = 0
		const updatesA: MCPProgressUpdate[] = []
		const updatesB: MCPProgressUpdate[] = []
		const cancelled = new AbortController()
		const a = h.client.callTool('first', {}, { onProgress: (update) => updatesA.push(update) })
		const b = h.client.callTool(
			'second',
			{},
			{
				signal: cancelled.signal,
				onProgress: (update) => updatesB.push(update),
			},
		)
		const [requestA, requestB] = h.sent.filter((message) => message.method === 'tools/call')
		if (!requestA || !requestB) throw new Error('both calls were not sent')
		const tokenA = token(requestA)
		const tokenB = token(requestB)
		expect(tokenA).not.toBe(tokenB)

		h.receive(progress(tokenB, 1, { total: 4, message: 'second' }))
		h.receive(progress(tokenA, 1, { total: 2, message: '\x1b[31mfirst\x1b[0m\nstep\u202e' }))
		h.receive(progress(tokenB, 1, { message: 'duplicate' }))
		h.receive(progress(tokenB, 0, { message: 'regressed' }))
		h.receive(progress(tokenB, Number.POSITIVE_INFINITY))
		h.receive(progress('unknown-token', 2))
		expect(updatesA).toEqual([{ progress: 1, total: 2, message: 'first step' }])
		expect(updatesB).toEqual([{ progress: 1, total: 4, message: 'second' }])

		h.receive(reply(requestA))
		await expect(a).resolves.toEqual({ content: [] })
		h.receive(progress(tokenA, 2, { message: 'late' }))
		expect(updatesA).toHaveLength(1)

		h.receive(progress(tokenB, 2, { total: -1, message: 'é'.repeat(500) }))
		expect(updatesB[1]?.total).toBeUndefined()
		expect(Buffer.byteLength(updatesB[1]?.message ?? '', 'utf8')).toBeLessThanOrEqual(512)
		const reason = new Error('cancelled')
		cancelled.abort(reason)
		await expect(b).rejects.toBe(reason)
		h.receive(progress(tokenB, 3, { message: 'late' }))
		expect(updatesB).toHaveLength(2)

		const quiet = h.client.callTool('quiet')
		const requestQuiet = h.sent.filter((message) => message.method === 'tools/call').at(-1)
		expect(
			(requestQuiet?.params?._meta as Record<string, unknown> | undefined)?.progressToken,
		).toBeUndefined()
		if (!requestQuiet) throw new Error('quiet call was not sent')
		h.receive(reply(requestQuiet))
		await expect(quiet).resolves.toEqual({ content: [] })
	})

	it('does not let a host progress observer break the tool response', async () => {
		const h = scriptedClient()
		await h.client.connect()
		const seen = vi.fn(() => {
			throw new Error('observer failed')
		})
		const result = h.client.callTool('read', {}, { onProgress: seen })
		const request = h.sent.filter((message) => message.method === 'tools/call').at(-1)
		if (!request) throw new Error('call was not sent')
		h.receive(progress(token(request), 1))
		h.receive(reply(request))
		await expect(result).resolves.toEqual({ content: [] })
		expect(seen).toHaveBeenCalledTimes(1)
	})

	it('routes interleaved notifications across a real stdio process', async () => {
		const client = new MCPClient({
			serverName: 'progress-peer',
			transport: { type: 'stdio', command: process.execPath, args: [FIXTURE] },
			eraCache: createMcpEraCache(),
		})
		try {
			await client.connect()
			const first: string[] = []
			const second: string[] = []
			const a = client.callTool(
				'first',
				{},
				{ onProgress: (update) => first.push(update.message ?? '') },
			)
			const b = client.callTool(
				'second',
				{},
				{ onProgress: (update) => second.push(update.message ?? '') },
			)
			await Promise.all([a, b])
			expect(first).toEqual(['first started'])
			expect(second).toEqual(['second started', 'second done'])
		} finally {
			await client.disconnect()
		}
	}, 10_000)

	it('routes progress from two simultaneous Streamable HTTP response streams', async () => {
		const requests = new Map<
			string,
			{ message: MCPJsonRpcMessage; answer: (response: Response) => void }
		>()
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>((_input, init) => {
				const message = JSON.parse(String(init?.body)) as MCPJsonRpcMessage
				if (message.method === 'server/discover') {
					return Promise.resolve(new Response('Not Found', { status: 404 }))
				}
				if (message.method === 'initialize') {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								jsonrpc: '2.0',
								id: message.id,
								result: {
									protocolVersion: '2024-11-05',
									serverInfo: { name: 'http-progress-peer' },
									capabilities: { tools: {} },
								},
							}),
							{ headers: { 'content-type': 'application/json' } },
						),
					)
				}
				if (message.method === 'notifications/initialized') {
					return Promise.resolve(new Response(null, { status: 202 }))
				}
				if (message.method !== 'tools/call') throw new Error(`unexpected ${message.method}`)
				return new Promise<Response>((answer) => {
					requests.set(String(message.params?.name), { message, answer })
				})
			}),
		)
		const client = new MCPClient({
			serverName: 'http-progress-peer',
			transport: { type: 'streamable_http', url: 'https://mcp.example.test/rpc' },
			eraCache: createMcpEraCache(),
		})
		const sse = (...messages: MCPJsonRpcMessage[]) =>
			new Response(messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join(''), {
				headers: { 'content-type': 'text/event-stream' },
			})
		try {
			await client.connect()
			const first: string[] = []
			const second: string[] = []
			const a = client.callTool(
				'first',
				{},
				{ onProgress: (update) => first.push(update.message ?? '') },
			)
			const b = client.callTool(
				'second',
				{},
				{ onProgress: (update) => second.push(update.message ?? '') },
			)
			const requestA = requests.get('first')
			const requestB = requests.get('second')
			if (!requestA || !requestB) throw new Error('both HTTP calls were not sent')
			requestA.answer(
				sse(
					progress(token(requestB.message), 1, { message: 'second started' }),
					progress(token(requestA.message), 1, { message: 'first started' }),
					reply(requestA.message),
				),
			)
			await a
			requestB.answer(
				sse(
					progress(token(requestA.message), 2, { message: 'late first' }),
					progress(token(requestB.message), 2, { message: 'second done' }),
					reply(requestB.message),
				),
			)
			await b
			expect(first).toEqual(['first started'])
			expect(second).toEqual(['second started', 'second done'])
		} finally {
			await client.disconnect()
		}
	})

	it('delivers interleaved HTTP progress before EOF and ends each response at its terminal reply', async () => {
		const encoder = new TextEncoder()
		const requests = new Map<
			string,
			{
				message: MCPJsonRpcMessage
				controller: ReadableStreamDefaultController<Uint8Array>
				cancelled: Promise<void>
			}
		>()
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>((_input, init) => {
				const message = JSON.parse(String(init?.body)) as MCPJsonRpcMessage
				if (message.method === 'server/discover') {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								jsonrpc: '2.0',
								id: message.id,
								result: {
									supportedVersions: ['2026-07-28'],
									capabilities: { tools: {} },
									_meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture' } },
								},
							}),
							{ headers: { 'content-type': 'application/json' } },
						),
					)
				}
				if (message.method !== 'tools/call') throw new Error(`unexpected ${message.method}`)
				let controller!: ReadableStreamDefaultController<Uint8Array>
				let markCancelled!: () => void
				const cancelled = new Promise<void>((resolve) => {
					markCancelled = resolve
				})
				const body = new ReadableStream<Uint8Array>({
					start(value) {
						controller = value
					},
					cancel() {
						markCancelled()
					},
				})
				requests.set(String(message.params?.name), { message, controller, cancelled })
				return Promise.resolve(
					new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
				)
			}),
		)
		const client = new MCPClient({
			serverName: 'fixture',
			transport: { type: 'streamable_http', url: 'https://mcp.example.test/rpc' },
			eraCache: createMcpEraCache(),
		})
		let firstProgress!: () => void
		let secondProgress!: () => void
		const firstSeen = new Promise<void>((resolve) => {
			firstProgress = resolve
		})
		const secondSeen = new Promise<void>((resolve) => {
			secondProgress = resolve
		})
		const first: string[] = []
		const second: string[] = []
		try {
			await client.connect()
			const a = client.callTool(
				'first',
				{},
				{
					onProgress: (update) => {
						first.push(update.message ?? '')
						firstProgress()
					},
				},
			)
			const b = client.callTool(
				'second',
				{},
				{
					onProgress: (update) => {
						second.push(update.message ?? '')
						secondProgress()
					},
				},
			)
			const requestA = requests.get('first')
			const requestB = requests.get('second')
			if (!requestA || !requestB) throw new Error('both HTTP calls were not sent')
			const event = (message: MCPJsonRpcMessage, newline = '\n') =>
				`data: ${JSON.stringify(message)}${newline}${newline}`
			requestA.controller.enqueue(
				encoder.encode(event(progress(token(requestB.message), 1, { message: 'second' }))),
			)
			const split = event(progress(token(requestA.message), 1, { message: 'first' }), '\r\n')
			requestA.controller.enqueue(encoder.encode(split.slice(0, -3)))
			// A decoder read may produce no text between the CR and LF.
			requestA.controller.enqueue(new Uint8Array())
			requestA.controller.enqueue(encoder.encode(split.slice(-3)))

			// The server has sent no final result and has not closed either body.
			// Awaiting these notifications fails under the old response.text() path.
			await Promise.all([firstSeen, secondSeen])
			expect(first).toEqual(['first'])
			expect(second).toEqual(['second'])
			requestA.controller.enqueue(encoder.encode(event(reply(requestA.message))))
			await a
			await requestA.cancelled
			requestB.controller.enqueue(
				encoder.encode(event(progress(token(requestA.message), 2, { message: 'late first' }))),
			)
			requestB.controller.enqueue(
				encoder.encode(event(progress(token(requestB.message), 2, { message: 'second done' }))),
			)
			requestB.controller.enqueue(encoder.encode(event(reply(requestB.message))))
			await b
			await requestB.cancelled
			expect(first).toEqual(['first'])
			expect(second).toEqual(['second', 'second done'])
		} finally {
			await client.disconnect()
		}
	}, 10_000)
})

afterEach(() => vi.unstubAllGlobals())
