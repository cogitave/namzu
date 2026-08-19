import { describe, expect, it } from 'vitest'

import type {
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportSendOptions,
	MCPTransportUnion,
} from '../../../types/connector/index.js'
import { MCPClient } from '../client.js'

interface SentFrame {
	readonly message: MCPJsonRpcMessage
	readonly options: MCPTransportSendOptions | undefined
}

interface Harness {
	readonly client: MCPClient
	readonly sent: SentFrame[]
	receive(message: MCPJsonRpcMessage): void
}

function harness(
	options: {
		readonly requestTimeoutMs?: number
		readonly onSend?: (
			message: MCPJsonRpcMessage,
			options: MCPTransportSendOptions | undefined,
			receive: (message: MCPJsonRpcMessage) => void,
		) => Promise<void>
	} = {},
): Harness {
	const sent: SentFrame[] = []
	let receive: ((message: MCPJsonRpcMessage) => void) | undefined
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		send: (message, sendOptions) => {
			sent.push({ message, options: sendOptions })
			if (message.method === 'initialize') {
				receive?.({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						protocolVersion: '2024-11-05',
						serverInfo: { name: 'fixture' },
						capabilities: { tools: {} },
					},
				})
				return Promise.resolve()
			}
			return (
				options.onSend?.(message, sendOptions, (response) => receive?.(response)) ??
				Promise.resolve()
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
		transport: { type: 'stdio', command: 'unused' } as MCPTransportUnion,
		...(options.requestTimeoutMs !== undefined
			? { requestTimeoutMs: options.requestTimeoutMs }
			: {}),
	})
	;(client as unknown as { transport: MCPTransport }).transport = transport
	return { client, sent, receive: (message) => receive?.(message) }
}

function pendingCount(client: MCPClient): number {
	return (client as unknown as { pendingRequests: Map<unknown, unknown> }).pendingRequests.size
}

function cancellationFrame(sent: readonly SentFrame[]): SentFrame | undefined {
	return sent.find(({ message }) => message.method === 'notifications/cancelled')
}

describe('MCP request cancellation owns the correlated operation', () => {
	it('refuses a pre-aborted request before assigning transport work', async () => {
		const h = harness()
		await h.client.connect()
		h.sent.length = 0
		const caller = new AbortController()
		const reason = new Error('request never had authority')
		caller.abort(reason)

		await expect(h.client.callTool('mutate', {}, { signal: caller.signal })).rejects.toBe(reason)

		expect(h.sent).toHaveLength(0)
		expect(pendingCount(h.client)).toBe(0)
	})

	it('preserves the caller cause, aborts only the private transport, and asks the peer to stop', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let privateSignal: AbortSignal | undefined
		const h = harness({
			onSend: (message, options) => {
				if (message.method !== 'tools/call') return Promise.resolve()
				privateSignal = options?.signal
				markStarted()
				return new Promise((_resolve, reject) => {
					privateSignal?.addEventListener(
						'abort',
						() =>
							reject(
								Object.assign(new Error('generic transport abort'), {
									name: 'AbortError',
								}),
							),
						{ once: true },
					)
				})
			},
		})
		await h.client.connect()
		h.sent.length = 0
		const caller = new AbortController()
		const pending = h.client.callTool('mutate', { value: 1 }, { signal: caller.signal })
		await started

		const reason = new Error('operator withdrew this call')
		caller.abort(reason)

		await expect(pending).rejects.toBe(reason)
		await new Promise((resolve) => setTimeout(resolve, 0))
		const request = h.sent.find(({ message }) => message.method === 'tools/call')
		const cancellation = cancellationFrame(h.sent)
		expect(privateSignal).toBeDefined()
		expect(privateSignal).not.toBe(caller.signal)
		expect(privateSignal?.aborted).toBe(true)
		expect(privateSignal?.reason).toBe(reason)
		expect(cancellation?.message.params).toEqual({
			requestId: request?.message.id,
			reason: 'Caller cancelled request',
		})
		expect(JSON.stringify(cancellation?.message)).not.toContain(reason.message)
		expect(pendingCount(h.client)).toBe(0)

		// A response after local authority ended has no pending owner and is ignored.
		h.receive({
			jsonrpc: '2.0',
			id: request?.message.id,
			result: { content: [] },
		})
		expect(pendingCount(h.client)).toBe(0)
	})

	it('times out with one exact cause, aborts transport, and correlates cancellation', async () => {
		let privateSignal: AbortSignal | undefined
		const h = harness({
			requestTimeoutMs: 5,
			onSend: (message, options) => {
				if (message.method === 'tools/list') {
					privateSignal = options?.signal
					return new Promise(() => {})
				}
				return Promise.resolve()
			},
		})
		await h.client.connect()
		h.sent.length = 0

		const error = await h.client.listTools().catch((caught: unknown) => caught)
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(error).toBeInstanceOf(Error)
		expect((error as Error).name).toBe('TimeoutError')
		expect((error as Error).message).toContain('timed out after 5ms')
		expect(privateSignal?.aborted).toBe(true)
		expect(privateSignal?.reason).toBe(error)
		const request = h.sent.find(({ message }) => message.method === 'tools/list')
		expect(cancellationFrame(h.sent)?.message.params).toEqual({
			requestId: request?.message.id,
			reason: 'Request deadline expired',
		})
		expect(pendingCount(h.client)).toBe(0)
	})

	it('does not retroactively cancel a response that won inside transport.send', async () => {
		const caller = new AbortController()
		const reason = new Error('too late to cancel the completed call')
		let privateSignal: AbortSignal | undefined
		const h = harness({
			onSend: (message, options, receive) => {
				if (message.method !== 'tools/call') return Promise.resolve()
				privateSignal = options?.signal
				receive({
					jsonrpc: '2.0',
					id: message.id,
					result: { content: [{ type: 'text', text: 'committed' }] },
				})
				caller.abort(reason)
				return Promise.resolve()
			},
		})
		await h.client.connect()
		h.sent.length = 0

		await expect(h.client.callTool('mutate', {}, { signal: caller.signal })).resolves.toEqual({
			content: [{ type: 'text', text: 'committed' }],
		})

		expect(caller.signal.aborted).toBe(true)
		expect(privateSignal?.aborted).toBe(false)
		expect(cancellationFrame(h.sent)).toBeUndefined()
		expect(pendingCount(h.client)).toBe(0)
	})

	it('rechecks one caller signal before starting the next list page', async () => {
		const caller = new AbortController()
		const reason = new Error('stop before page two')
		let listCalls = 0
		const h = harness({
			onSend: (message, _options, receive) => {
				if (message.method !== 'tools/list') return Promise.resolve()
				listCalls++
				receive({
					jsonrpc: '2.0',
					id: message.id,
					result: { tools: [{ name: 'page-one' }], nextCursor: 'page-two' },
				})
				caller.abort(reason)
				return Promise.resolve()
			},
		})
		await h.client.connect()

		await expect(h.client.listTools({ signal: caller.signal })).rejects.toBe(reason)
		expect(listCalls).toBe(1)
		expect(pendingCount(h.client)).toBe(0)
	})

	it('aborts an in-flight best-effort cancellation when the client disconnects', async () => {
		let markCancelStarted!: () => void
		const cancelStarted = new Promise<void>((resolve) => {
			markCancelStarted = resolve
		})
		let cancellationSignal: AbortSignal | undefined
		const h = harness({
			onSend: (message, options) => {
				if (message.method === 'notifications/cancelled') {
					cancellationSignal = options?.signal
					markCancelStarted()
					return new Promise<void>(() => {})
				}
				if (message.method !== 'tools/call') return Promise.resolve()
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						'abort',
						() => reject(Object.assign(new Error('request aborted'), { name: 'AbortError' })),
						{ once: true },
					)
				})
			},
		})
		await h.client.connect()
		const caller = new AbortController()
		const pending = h.client.callTool('mutate', {}, { signal: caller.signal })
		const reason = new Error('stop request before disconnect')
		caller.abort(reason)
		await expect(pending).rejects.toBe(reason)
		await cancelStarted

		await h.client.disconnect()

		expect(cancellationSignal?.aborted).toBe(true)
		expect((cancellationSignal?.reason as Error).message).toBe('MCPClient disconnecting')
		expect(
			(h.client as unknown as { cancellationControllers: Set<unknown> }).cancellationControllers
				.size,
		).toBe(0)
	})
})

describe('MCP request deadline configuration', () => {
	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'refuses invalid requestTimeoutMs=%s at construction',
		(requestTimeoutMs) => {
			expect(() => harness({ requestTimeoutMs })).toThrow(/must be an integer from 1/)
		},
	)
})
