import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
	MCPFetchLike,
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportSendOptions,
} from '../../../types/connector/index.js'
import { MCPClient } from '../client.js'
import { createMcpEraCache } from '../era.js'
import { mcpToolset } from '../mcp-toolset.js'
import { StreamableHttpTransport } from '../streamable-http.js'

const subscriptionIdKey = 'io.modelcontextprotocol/subscriptionId'

function response(message: MCPJsonRpcMessage): Response {
	return new Response(JSON.stringify(message), {
		headers: { 'content-type': 'application/json' },
	})
}

function notification(
	method: string,
	id: number,
	extra: Record<string, unknown> = {},
): MCPJsonRpcMessage {
	return {
		jsonrpc: '2.0',
		method,
		params: { ...extra, _meta: { [subscriptionIdKey]: id } },
	}
}

function event(message: MCPJsonRpcMessage): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(message)}\r\n\r\n`)
}

function nextChange(onChange: ((listener: () => void) => () => void) | undefined): Promise<void> {
	if (!onChange) throw new Error('toolset has no onChange')
	return new Promise((resolve) => {
		const off = onChange(() => {
			off()
			resolve()
		})
	})
}

afterEach(() => {
	vi.useRealTimers()
})

describe('modern MCP subscriptions/listen', () => {
	it('streams acknowledged changes into the live toolset without waiting for the SSE response to end', async () => {
		let stream!: ReadableStreamDefaultController<Uint8Array>
		let tools = ['before']
		const requests: Array<{ message: MCPJsonRpcMessage; init: Parameters<MCPFetchLike>[1] }> = []
		const fetcher: MCPFetchLike = async (_url, init) => {
			const message = JSON.parse(init?.body ?? '{}') as MCPJsonRpcMessage
			requests.push({ message, init })
			if (message.method === 'server/discover') {
				return response({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						supportedVersions: ['2026-07-28'],
						capabilities: {
							tools: { listChanged: true },
							prompts: { listChanged: true },
							resources: { listChanged: false },
						},
					},
				})
			}
			if (message.method === 'subscriptions/listen') {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							stream = controller
						},
					}),
					{
						headers: { 'content-type': 'text/event-stream' },
					},
				)
			}
			if (message.method === 'tools/list') {
				return response({
					jsonrpc: '2.0',
					id: message.id,
					result: { tools: tools.map((name) => ({ name, inputSchema: { type: 'object' } })) },
				})
			}
			if (message.method === 'prompts/list') {
				return response({ jsonrpc: '2.0', id: message.id, result: { prompts: [] } })
			}
			if (message.method === 'resources/list') {
				return response({ jsonrpc: '2.0', id: message.id, result: { resources: [] } })
			}
			throw new Error(`Unexpected method ${message.method}`)
		}
		const client = new MCPClient({
			serverName: 'fixture',
			transport: { type: 'streamable_http', url: 'https://mcp.example.test/mcp', fetch: fetcher },
			eraCache: createMcpEraCache(),
		})
		await client.connect()
		const entries = await mcpToolset(client)
		const listen = requests.find((request) => request.message.method === 'subscriptions/listen')
		expect(listen?.message.params?.notifications).toEqual({
			toolsListChanged: true,
			promptsListChanged: true,
		})
		expect(listen?.init?.headers?.['MCP-Protocol-Version']).toBe('2026-07-28')
		expect(listen?.init?.redirect).toBe('manual')
		const id = listen?.message.id
		if (typeof id !== 'number') throw new Error('subscription id was not a number')

		// The frame delimiter is split across chunks, including at CRLF. The
		// transport must not wait for the never-ending response.text().
		const acknowledged = event(
			notification('notifications/subscriptions/acknowledged', id, {
				notifications: { toolsListChanged: true, promptsListChanged: true },
			}),
		)
		const synchronized = nextChange(entries[0].onChange)
		stream.enqueue(acknowledged.slice(0, acknowledged.length - 3))
		stream.enqueue(acknowledged.slice(acknowledged.length - 3))
		await synchronized
		const changed = nextChange(entries[0].onChange)
		tools = ['after']
		stream.enqueue(event(notification('notifications/tools/list_changed', id)))
		await changed
		expect(entries[0].tools().map((tool) => tool.name)).toContain('mcp__fixture__after')
		expect(entries[0].tools().map((tool) => tool.name)).not.toContain('mcp__fixture__before')
		await entries[0].close?.()
		await client.disconnect()
		expect(listen?.init?.signal?.aborted).toBe(true)
		await client.connect()
		const listenIds = requests
			.filter((request) => request.message.method === 'subscriptions/listen')
			.map((request) => request.message.id)
		expect(listenIds).toHaveLength(2)
		expect(listenIds[1]).not.toBe(listenIds[0])
		await client.disconnect()
	})

	it('accepts only the active subscription ID, its first acknowledgment and requested kinds', async () => {
		const sent: MCPJsonRpcMessage[] = []
		let receive!: (message: MCPJsonRpcMessage) => void
		const transport: MCPTransport = {
			connect: async () => {},
			close: async () => {},
			isConnected: () => true,
			send: async (message: MCPJsonRpcMessage, _options?: MCPTransportSendOptions) => {
				sent.push(message)
				if (message.method === 'server/discover') {
					queueMicrotask(() =>
						receive({
							jsonrpc: '2.0',
							id: message.id,
							result: {
								supportedVersions: ['2026-07-28'],
								capabilities: { tools: { listChanged: true } },
							},
						}),
					)
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
			transport: { type: 'stdio', command: 'fake' },
			eraCache: createMcpEraCache(),
		})
		;(client as unknown as { transport: MCPTransport }).transport = transport
		const seen: string[] = []
		client.onNotification((method) => seen.push(method))
		await client.connect()
		const id = sent.find((message) => message.method === 'subscriptions/listen')?.id
		if (typeof id !== 'number') throw new Error('subscription was not sent')

		receive(
			notification('notifications/subscriptions/acknowledged', id + 100, {
				notifications: { toolsListChanged: true },
			}),
		)
		receive(notification('notifications/tools/list_changed', id + 100))
		expect(seen).toEqual([])
		receive(
			notification('notifications/subscriptions/acknowledged', id, {
				notifications: { toolsListChanged: true },
			}),
		)
		// One reconciliation on acknowledgment covers changes while opening.
		expect(seen).toEqual(['notifications/tools/list_changed'])
		receive(notification('notifications/prompts/list_changed', id))
		receive({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
		expect(seen).toHaveLength(1)
		receive(notification('notifications/tools/list_changed', id))
		expect(seen).toHaveLength(2)
		await client.disconnect()
	})

	it('times out an absent acknowledgment and retries with a new request ID', async () => {
		vi.useFakeTimers()
		const sent: MCPJsonRpcMessage[] = []
		let receive!: (message: MCPJsonRpcMessage) => void
		const transport: MCPTransport = {
			connect: async () => {},
			close: async () => {},
			isConnected: () => true,
			send: async (message) => {
				sent.push(message)
				if (message.method === 'server/discover')
					queueMicrotask(() =>
						receive({
							jsonrpc: '2.0',
							id: message.id,
							result: {
								supportedVersions: ['2026-07-28'],
								capabilities: { tools: { listChanged: true } },
							},
						}),
					)
			},
			onMessage: (handler) => {
				receive = handler
			},
			onClose: () => {},
			onError: () => {},
		}
		const client = new MCPClient({
			serverName: 'fixture',
			transport: { type: 'stdio', command: 'fake' },
			eraCache: createMcpEraCache(),
			requestTimeoutMs: 50,
		})
		;(client as unknown as { transport: MCPTransport }).transport = transport
		await client.connect()
		const original = sent.find((message) => message.method === 'subscriptions/listen')?.id
		await vi.advanceTimersByTimeAsync(50)
		await vi.advanceTimersByTimeAsync(1_000)
		const listens = sent.filter((message) => message.method === 'subscriptions/listen')
		expect(listens).toHaveLength(2)
		expect(listens[0]?.id).toBe(original)
		expect(listens[1]?.id).not.toBe(original)
		await client.disconnect()
	})

	it('bounds an incomplete subscription event rather than buffering without limit', async () => {
		const fetcher: MCPFetchLike = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(1_048_577)}`))
						controller.close()
					},
				}),
				{ headers: { 'content-type': 'text/event-stream' } },
			)
		const transport = new StreamableHttpTransport({
			type: 'streamable_http',
			url: 'https://mcp.example.test/mcp',
			fetch: fetcher,
		})
		await transport.connect()
		await expect(
			transport.sendSubscription(
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'subscriptions/listen',
					params: { notifications: { toolsListChanged: true } },
				},
				{ signal: new AbortController().signal },
			),
		).rejects.toThrow(/exceeds its size limit/)
		await transport.close()
	})

	it('reopens an unexpectedly closed stream, but stops after a graceful result', async () => {
		vi.useFakeTimers()
		const streams: ReadableStreamDefaultController<Uint8Array>[] = []
		const listens: MCPJsonRpcMessage[] = []
		const fetcher: MCPFetchLike = async (_url, init) => {
			const message = JSON.parse(init?.body ?? '{}') as MCPJsonRpcMessage
			if (message.method === 'server/discover')
				return response({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						supportedVersions: ['2026-07-28'],
						capabilities: { tools: { listChanged: true } },
					},
				})
			if (message.method !== 'subscriptions/listen')
				throw new Error(`Unexpected method ${message.method}`)
			listens.push(message)
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						streams.push(controller)
					},
				}),
				{
					headers: { 'content-type': 'text/event-stream' },
				},
			)
		}
		const client = new MCPClient({
			serverName: 'fixture',
			transport: { type: 'streamable_http', url: 'https://mcp.example.test/mcp', fetch: fetcher },
			eraCache: createMcpEraCache(),
		})
		await client.connect()
		const firstId = listens[0]?.id
		if (typeof firstId !== 'number') throw new Error('subscription was not sent')
		streams[0]?.enqueue(
			event(
				notification('notifications/subscriptions/acknowledged', firstId, {
					notifications: { toolsListChanged: true },
				}),
			),
		)
		streams[0]?.close()
		await vi.advanceTimersByTimeAsync(1_000)
		expect(listens).toHaveLength(2)
		const secondId = listens[1]?.id
		if (typeof secondId !== 'number') throw new Error('retry subscription was not sent')
		expect(secondId).not.toBe(firstId)
		streams[1]?.enqueue(
			event(
				notification('notifications/subscriptions/acknowledged', secondId, {
					notifications: { toolsListChanged: true },
				}),
			),
		)
		streams[1]?.enqueue(event({ jsonrpc: '2.0', id: secondId, result: {} }))
		await vi.advanceTimersByTimeAsync(60_000)
		expect(listens).toHaveLength(2)
		await client.disconnect()
	})

	it('rejects a first HTTP stream frame that is not its acknowledgment', async () => {
		vi.useFakeTimers()
		let stream!: ReadableStreamDefaultController<Uint8Array>
		const listens: MCPJsonRpcMessage[] = []
		const fetcher: MCPFetchLike = async (_url, init) => {
			const message = JSON.parse(init?.body ?? '{}') as MCPJsonRpcMessage
			if (message.method === 'server/discover')
				return response({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						supportedVersions: ['2026-07-28'],
						capabilities: { tools: { listChanged: true } },
					},
				})
			if (message.method !== 'subscriptions/listen')
				throw new Error(`Unexpected method ${message.method}`)
			listens.push(message)
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						stream = controller
					},
				}),
				{
					headers: { 'content-type': 'text/event-stream' },
				},
			)
		}
		const client = new MCPClient({
			serverName: 'fixture',
			transport: { type: 'streamable_http', url: 'https://mcp.example.test/mcp', fetch: fetcher },
			eraCache: createMcpEraCache(),
		})
		const seen: string[] = []
		client.onNotification((method) => seen.push(method))
		await client.connect()
		const id = listens[0]?.id
		if (typeof id !== 'number') throw new Error('subscription was not sent')
		stream.enqueue(event(notification('notifications/tools/list_changed', id)))
		await vi.advanceTimersByTimeAsync(1_000)
		expect(seen).toEqual([])
		expect(listens).toHaveLength(2)
		await client.disconnect()
	})

	it('accepts bare CR SSE separators and aborts a waiting reader on close', async () => {
		let stream!: ReadableStreamDefaultController<Uint8Array>
		const fetcher: MCPFetchLike = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						stream = controller
					},
				}),
				{ headers: { 'content-type': 'Text/Event-Stream; charset=utf-8' } },
			)
		const transport = new StreamableHttpTransport({
			type: 'streamable_http',
			url: 'https://mcp.example.test/mcp',
			fetch: fetcher,
		})
		await transport.connect()
		let delivered!: () => void
		const received = new Promise<void>((resolve) => {
			delivered = resolve
		})
		const sending = transport.sendSubscription(
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'subscriptions/listen',
				params: { notifications: { toolsListChanged: true } },
			},
			{ signal: new AbortController().signal },
			() => delivered(),
		)
		stream.enqueue(
			new TextEncoder().encode(
				'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\r\r',
			),
		)
		await received
		await transport.close()
		await sending
	})
})
