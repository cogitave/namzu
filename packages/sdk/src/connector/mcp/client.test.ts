import { describe, expect, it, vi } from 'vitest'

import type {
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportUnion,
} from '../../types/connector/index.js'
import { MCPClient } from './client.js'
import { createMcpEraCache } from './era.js'

/**
 * `client.ts` had zero test coverage, and three ways to hang a run:
 *
 * - `request()` armed no timer, so a wedged stdio server left every caller
 *   pending forever — no error, no `turn_failed`, just a process that stopped.
 * - Pending requests were only rejected by `disconnect()`, so a transport
 *   that dropped on its own leaked them.
 * - A frame carrying BOTH an id and a method (a server-initiated request:
 *   `sampling/createMessage`, `elicitation/create`, `roots/list`, `ping`)
 *   matched neither branch of `handleMessage` and was silently discarded,
 *   leaving the server waiting for a reply that never came.
 *
 * This is a first-party MCP implementation with no `@modelcontextprotocol/sdk`
 * dependency, so nothing is inherited from upstream.
 */

interface Harness {
	client: MCPClient
	sent: MCPJsonRpcMessage[]
	/** Deliver a frame as if the server sent it. */
	receive(msg: MCPJsonRpcMessage): void
	closeTransport(): void
	failTransport(err: Error): void
}

function harness(opts: { autoInitialize?: boolean; requestTimeoutMs?: number } = {}): Harness {
	const sent: MCPJsonRpcMessage[] = []
	let onMessage: ((m: MCPJsonRpcMessage) => void) | undefined
	let onClose: (() => void) | undefined
	let onError: ((e: Error) => void) | undefined

	let open = true
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {
			open = false
		},
		isConnected: () => open,
		send: async (message) => {
			sent.push(message)
			if (message.method === 'server/discover') {
				// Not a `DiscoverResult` (no `supportedVersions`), so the era
				// probe reads this as a fast, clean "legacy" rather than
				// waiting out the probe timeout for silence — this harness's
				// own `eraCache` never sees another test's answer.
				queueMicrotask(() => onMessage?.({ jsonrpc: '2.0', id: message.id, result: {} }))
				return
			}
			// Answer `initialize` so `connect()` can complete.
			if (opts.autoInitialize !== false && message.method === 'initialize') {
				queueMicrotask(() =>
					onMessage?.({
						jsonrpc: '2.0',
						id: message.id,
						result: { serverInfo: { name: 'fake', version: '1' }, capabilities: {} },
					}),
				)
			}
		},
		onMessage: (h) => {
			onMessage = h
		},
		onClose: (h) => {
			onClose = h
		},
		onError: (h) => {
			onError = h
		},
	}

	const client = new MCPClient({
		serverName: 'fake',
		transport: { type: 'stdio', command: 'noop' } as MCPTransportUnion,
		// A fresh cache per client: the shared process-default cache would
		// let an era resolved by an unrelated test leak in here and make
		// this suite order-dependent on whether it runs before or after one
		// that already resolved 'noop' to an era.
		eraCache: createMcpEraCache(),
		...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
	})
	// Swap in the fake transport; `createTransport` would spawn a process.
	;(client as unknown as { transport: MCPTransport }).transport = transport

	return {
		client,
		sent,
		receive: (msg) => onMessage?.(msg),
		closeTransport: () => onClose?.(),
		failTransport: (err) => onError?.(err),
	}
}

describe('MCPClient — a wedged server cannot hang the run', () => {
	it('times out a request that is never answered', async () => {
		const h = harness({ requestTimeoutMs: 25 })
		await h.client.connect()

		await expect(h.client.listTools()).rejects.toThrow(/timed out after 25ms/)
	})

	it('rejects in-flight requests when the transport closes on its own', async () => {
		const h = harness({ requestTimeoutMs: 10_000 })
		await h.client.connect()

		const pending = h.client.listTools()
		h.closeTransport()

		await expect(pending).rejects.toThrow(/closed/)
	})

	it('rejects in-flight requests when the transport errors', async () => {
		const h = harness({ requestTimeoutMs: 10_000 })
		await h.client.connect()

		const pending = h.client.listTools()
		h.failTransport(new Error('broken pipe'))

		await expect(pending).rejects.toThrow(/broken pipe/)
	})

	it('clears the timer on a normal reply — no late rejection', async () => {
		const h = harness({ requestTimeoutMs: 50 })
		await h.client.connect()

		const pending = h.client.listTools()
		// Read back the id `connect()`'s own era probe left this request at,
		// rather than assuming `tools/list` is request 2: a fresh `eraCache`
		// means every test in this file spends its own `server/discover`
		// probe id, so which numeric id `tools/list` lands on is no longer
		// this test's business.
		const toolsList = h.sent.find((m) => m.method === 'tools/list')
		if (!toolsList) throw new Error('tools/list was never sent')
		h.receive({ jsonrpc: '2.0', id: toolsList.id, result: { tools: [{ name: 'a' }] } })

		await expect(pending).resolves.toEqual([{ name: 'a' }])
		// Outlive the timeout; a stale timer would surface as an unhandled
		// rejection here.
		await new Promise((r) => setTimeout(r, 80))
	})
})

describe('MCPClient — server-initiated requests are answered, not dropped', () => {
	it('replies -32601 to an unsupported server request instead of going silent', async () => {
		const h = harness()
		await h.client.connect()
		h.sent.length = 0

		h.receive({ jsonrpc: '2.0', id: 99, method: 'sampling/createMessage', params: {} })
		await new Promise((r) => setTimeout(r, 0))

		const reply = h.sent.find((m) => m.id === 99)
		expect(reply).toBeDefined()
		expect(reply?.error?.code).toBe(-32601)
		expect(reply?.error?.message).toContain('sampling/createMessage')
	})

	it('still routes notifications (no id) to notification handlers', async () => {
		const h = harness()
		await h.client.connect()
		const seen = vi.fn()
		h.client.onNotification(seen)
		h.sent.length = 0

		h.receive({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} })

		expect(seen).toHaveBeenCalledWith('notifications/tools/list_changed', {})
		// A notification must NOT be answered.
		expect(h.sent).toHaveLength(0)
	})
})
