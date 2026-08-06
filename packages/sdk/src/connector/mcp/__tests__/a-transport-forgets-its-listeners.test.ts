import { describe, expect, it } from 'vitest'

import type { MCPJsonRpcMessage } from '../../../types/connector/index.js'
import { HttpSseTransport } from '../http-sse.js'
import { StreamableHttpTransport } from '../streamable-http.js'

/**
 * Handler registration was append-only and nothing ever dropped it.
 *
 * `MCPClient.connect()` calls `onMessage`, `onClose` and `onError` once each,
 * and it is reachable again after `disconnect()` — the guard only refuses when
 * the status is already `connected`. So every reconnect stacked another set on
 * the last: after n cycles one inbound message dispatched to n handlers, n-1
 * of them closures over dead sessions. `rejectAllPending` and `emitLifecycle`
 * fired n times per close, and the stale closures held their old client state
 * alive for as long as the transport object did.
 *
 * The two HTTP transports are exercised here because they notify inside
 * `close()`. `StdioTransport` notifies from the child process's own `close`
 * event, so its handlers deliberately outlive the `close()` call and are
 * dropped after that event fires — clearing them earlier would leave the
 * client believing it was still connected, and its next `connect()` would be
 * refused with "already connected". That ordering is the reason the obvious
 * one-line fix is wrong there.
 */

const MESSAGE = { jsonrpc: '2.0', method: 'ping' } as MCPJsonRpcMessage

interface Transport {
	close(): Promise<void>
	onMessage(handler: (message: MCPJsonRpcMessage) => void): void
	onClose(handler: () => void): void
}

/**
 * `open` puts the transport in the state where `close()` notifies.
 *
 * They differ, and the difference is real rather than a test artefact:
 * `StreamableHttpTransport.close()` returns early when it was never connected,
 * `HttpSseTransport.close()` notifies regardless. Streamable's `connect()`
 * does no I/O — it sets a flag — so opening it here reaches no network. The
 * divergence itself is left alone; making the two agree changes what a host
 * observes and deserves its own decision.
 */
const IMPLEMENTATIONS: ReadonlyArray<
	readonly [string, () => Transport, (t: Transport) => Promise<void>]
> = [
	[
		'http-sse',
		() => new HttpSseTransport({ url: 'http://127.0.0.1:1/mcp' } as never),
		async () => {},
	],
	[
		'streamable-http',
		() => new StreamableHttpTransport({ url: 'http://127.0.0.1:1/mcp' } as never),
		async (t) => {
			await (t as unknown as { connect(): Promise<void> }).connect()
		},
	],
]

describe.each(IMPLEMENTATIONS)(
	'a %s transport forgets its listeners on close',
	(_n, build, open) => {
		it('notifies each close handler exactly once per registration', async () => {
			const transport = build()
			await open(transport)
			let closes = 0
			transport.onClose(() => {
				closes++
			})

			await transport.close()
			// A second registration is what a reconnect does. If the first
			// survived the close, this close fires twice.
			await open(transport)
			transport.onClose(() => {
				closes++
			})
			await transport.close()

			expect(closes).toBe(2)
		})

		it('does not dispatch a message to a handler from a closed session', async () => {
			// The consequence a host actually sees: work done twice, by a
			// closure that belongs to a session that ended.
			const seen: string[] = []
			const transport = build()
			await open(transport)
			transport.onMessage(() => seen.push('first'))

			await transport.close()
			await open(transport)
			transport.onMessage(() => seen.push('second'))
			dispatch(transport, MESSAGE)

			expect(seen).toEqual(['second'])
		})

		it('still notifies the handlers registered for the session being closed', async () => {
			// The failure mode of clearing too eagerly: close arrives, nobody is
			// told, and the client believes it is still connected.
			const transport = build()
			await open(transport)
			const order: string[] = []
			transport.onClose(() => order.push('notified'))

			await transport.close()

			expect(order).toEqual(['notified'])
		})
	},
)

/**
 * Reach the private dispatch the way an inbound frame does. Both transports
 * loop `messageHandlers` from their own parse path; there is no public method
 * that pushes a message in, and adding one for a test would be a surface
 * nobody asked for.
 */
function dispatch(transport: Transport, message: MCPJsonRpcMessage): void {
	const handlers = (
		transport as unknown as { messageHandlers: Array<(m: MCPJsonRpcMessage) => void> }
	).messageHandlers
	for (const handler of handlers) handler(message)
}
