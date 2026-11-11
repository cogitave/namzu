import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
	MCPClientConfig,
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportUnion,
} from '../../../types/connector/index.js'
import { MCPClient } from '../client.js'
import { createMcpEraCache } from '../era.js'

const TIMEOUT = 1000

interface Harness {
	readonly client: MCPClient
	readonly sent: MCPJsonRpcMessage[]
	/** Send a progress notification for the one pending tools/call. */
	progress(value: number): void
	respond(): void
}

function harness(config: Partial<MCPClientConfig> = {}): Harness {
	const sent: MCPJsonRpcMessage[] = []
	let receive: ((message: MCPJsonRpcMessage) => void) | undefined
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		send: (message) => {
			sent.push(message)
			if (message.method === 'server/discover') {
				receive?.({ jsonrpc: '2.0', id: message.id, result: {} })
			} else if (message.method === 'initialize') {
				receive?.({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						protocolVersion: '2024-11-05',
						serverInfo: { name: 'fixture' },
						capabilities: { tools: {} },
					},
				})
			} else if (message.method === 'tools/call' || message.method === 'tools/list') {
				// A request the server never answers on its own.
				return new Promise<void>(() => {})
			}
			return Promise.resolve()
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
		eraCache: createMcpEraCache(),
		requestTimeoutMs: TIMEOUT,
		...config,
	})
	;(client as unknown as { transport: MCPTransport }).transport = transport
	const call = (): MCPJsonRpcMessage => {
		const frame = sent.find((m) => m.method === 'tools/call')
		if (!frame) throw new Error('no tools/call sent')
		return frame
	}
	return {
		client,
		sent,
		progress: (value) => {
			const token = (call().params as { _meta: { progressToken: string } })._meta.progressToken
			receive?.({
				jsonrpc: '2.0',
				method: 'notifications/progress',
				params: { progressToken: token, progress: value },
			})
		},
		respond: () => {
			receive?.({
				jsonrpc: '2.0',
				id: call().id,
				result: { content: [{ type: 'text', text: 'done' }] },
			})
		},
	}
}

function pendingCount(client: MCPClient): number {
	return (client as unknown as { pendingRequests: Map<unknown, unknown> }).pendingRequests.size
}
function registrations(client: MCPClient): number {
	return (client as unknown as { progressRequests: Map<unknown, unknown> }).progressRequests.size
}
function cancellation(h: Harness): MCPJsonRpcMessage | undefined {
	return h.sent.find((m) => m.method === 'notifications/cancelled')
}

/** connect() settles on real timers; the deadline under test runs on the fake clock. */
async function connect(h: Harness): Promise<void> {
	vi.useRealTimers()
	await h.client.connect()
	vi.useFakeTimers()
}

async function start(h: Harness, signal?: AbortSignal) {
	await connect(h)
	h.sent.length = 0
	const outcome = h.client
		.callTool('slow', {}, { onProgress: () => {}, ...(signal ? { signal } : {}) })
		.then(
			(value) => ({ value }),
			(error: Error) => ({ error }),
		)
	await vi.advanceTimersByTimeAsync(0)
	// Boxed: returning the promise itself would make `start` wait for it.
	return { outcome }
}

describe('a progress-extended request deadline', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('off by default: progress does not move the deadline', async () => {
		const h = harness()
		const { outcome } = await start(h)
		await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
		h.progress(1)
		await vi.advanceTimersByTimeAsync(1)
		const result = await outcome
		expect((result as { error: Error }).error.message).toContain(`timed out after ${TIMEOUT}ms`)
		expect((result as { error: Error }).error.message).not.toContain('progress')
		expect(cancellation(h)).toBeDefined()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('on: progress every deadline-minus-one keeps the call alive past several deadlines', async () => {
		const h = harness({ resetTimeoutOnProgress: true })
		const { outcome } = await start(h)
		for (let i = 1; i <= 5; i++) {
			await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
			h.progress(i)
		}
		h.respond()
		const result = await outcome
		expect(result).toHaveProperty('value')
		expect(cancellation(h)).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
		expect(pendingCount(h.client)).toBe(0)
		expect(registrations(h.client)).toBe(0)
	})

	it('on: progress that stops lets the idle deadline fire after the last accepted progress', async () => {
		const h = harness({ resetTimeoutOnProgress: true })
		const { outcome } = await start(h)
		await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
		h.progress(1)
		await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
		expect(pendingCount(h.client)).toBe(1)
		await vi.advanceTimersByTimeAsync(1)
		const { error } = (await outcome) as { error: Error }
		expect(error.name).toBe('TimeoutError')
		expect(error.message).toContain(`timed out after ${TIMEOUT}ms with no progress`)
		expect(cancellation(h)?.params).toMatchObject({ reason: 'Request deadline expired' })
		expect(vi.getTimerCount()).toBe(0)
		expect(pendingCount(h.client)).toBe(0)
		expect(registrations(h.client)).toBe(0)
	})

	it('on: progress that never stops is cut at the total cap', async () => {
		const cap = TIMEOUT * 3
		const h = harness({ resetTimeoutOnProgress: true, maxTotalTimeoutMs: cap })
		const { outcome } = await start(h)
		let value = 0
		let elapsed = 0
		while (elapsed + 500 < cap) {
			await vi.advanceTimersByTimeAsync(500)
			elapsed += 500
			h.progress(++value)
		}
		await vi.advanceTimersByTimeAsync(cap - elapsed)
		const { error } = (await outcome) as { error: Error }
		expect(error.name).toBe('TimeoutError')
		expect(error.message).toContain(`total limit of ${cap}ms`)
		expect(cancellation(h)).toBeDefined()
		expect(vi.getTimerCount()).toBe(0)
		expect(pendingCount(h.client)).toBe(0)
		expect(registrations(h.client)).toBe(0)
	})

	it('on: the default cap is ten request deadlines', async () => {
		const h = harness({ resetTimeoutOnProgress: true })
		const { outcome } = await start(h)
		let value = 0
		for (let t = 0; t < 10; t++) {
			await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
			h.progress(++value)
		}
		await vi.advanceTimersByTimeAsync(10)
		const { error } = (await outcome) as { error: Error }
		expect(error.message).toContain(`total limit of ${TIMEOUT * 10}ms`)
	})

	it('on: a repeated or decreasing value does not extend the deadline', async () => {
		const h = harness({ resetTimeoutOnProgress: true })
		const { outcome } = await start(h)
		await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
		h.progress(5)
		await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
		h.progress(5)
		h.progress(3)
		await vi.advanceTimersByTimeAsync(1)
		const { error } = (await outcome) as { error: Error }
		expect(error.message).toContain('with no progress')
		expect(vi.getTimerCount()).toBe(0)
	})

	it('on: a caller abort wins and leaves no timer', async () => {
		const h = harness({ resetTimeoutOnProgress: true })
		const caller = new AbortController()
		const { outcome } = await start(h, caller.signal)
		await vi.advanceTimersByTimeAsync(10)
		h.progress(1)
		const reason = new Error('withdrawn')
		caller.abort(reason)
		const { error } = (await outcome) as { error: Error }
		expect(error).toBe(reason)
		expect(cancellation(h)?.params).toMatchObject({ reason: 'Caller cancelled request' })
		expect(vi.getTimerCount()).toBe(0)
		expect(registrations(h.client)).toBe(0)
	})

	it('on: a request that is not a progress-carrying tool call keeps the plain deadline and no cap timer', async () => {
		const h = harness({ resetTimeoutOnProgress: true })
		await connect(h)
		h.sent.length = 0
		const listing = h.client.listTools().catch((error: Error) => error)
		await vi.advanceTimersByTimeAsync(0)
		expect(vi.getTimerCount()).toBe(1)
		await vi.advanceTimersByTimeAsync(TIMEOUT)
		const error = (await listing) as Error
		expect(error.message).toContain(`timed out after ${TIMEOUT}ms`)
		expect(error.message).not.toContain('progress')
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe('progress deadline configuration', () => {
	const make = (config: Partial<MCPClientConfig>) => () =>
		new MCPClient({
			serverName: 'fixture',
			transport: { type: 'stdio', command: 'unused' } as MCPTransportUnion,
			eraCache: createMcpEraCache(),
			requestTimeoutMs: TIMEOUT,
			...config,
		})

	it('accepts a cap equal to the request deadline', () => {
		expect(make({ resetTimeoutOnProgress: true, maxTotalTimeoutMs: TIMEOUT })).not.toThrow()
	})

	it.each([
		['below requestTimeoutMs', TIMEOUT - 1, /must not be below requestTimeoutMs/],
		['zero', 0, /maxTotalTimeoutMs must be an integer/],
		['negative', -5, /maxTotalTimeoutMs must be an integer/],
		['NaN', Number.NaN, /maxTotalTimeoutMs must be an integer/],
		['Infinity', Number.POSITIVE_INFINITY, /maxTotalTimeoutMs must be an integer/],
		['fractional', 1500.5, /maxTotalTimeoutMs must be an integer/],
	])('refuses a cap that is %s', (_label, value, message) => {
		expect(make({ resetTimeoutOnProgress: true, maxTotalTimeoutMs: value })).toThrow(message)
	})

	it('refuses a bad cap even while the option is off', () => {
		expect(make({ maxTotalTimeoutMs: 0 })).toThrow(/maxTotalTimeoutMs/)
	})

	it('derives a default cap that fits a very large requestTimeoutMs', () => {
		expect(make({ resetTimeoutOnProgress: true, requestTimeoutMs: 2_147_483_647 })).not.toThrow()
	})
})
