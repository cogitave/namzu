import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MCPClient } from '../client.js'
import { MCPReconnectSupervisor } from '../reconnect.js'

/**
 * `MCPClient.connect()` was called exactly once, by whoever built the client.
 * `transport.onClose` set `status = 'disconnected'`, emitted the lifecycle
 * event and rejected everything pending — and nothing anywhere scheduled a
 * second attempt. One blip, one server restart, one laptop sleep, and the
 * plugin's tools were gone for the life of the process while the plugin
 * itself kept reporting as enabled.
 *
 * The awkward part is the one these tests spend the most on: a deliberate
 * `disconnect()` emits the SAME `mcp_client_disconnected` event a dead
 * transport does, and the event carries nothing that separates them. So the
 * stop-before-disconnect ordering is the contract, and a supervisor that
 * ignored it would reconnect exactly what a host had just torn down.
 *
 * Stop settles a pending backoff, then the loop observes `stopped`. A connect
 * already in progress may settle later; neither success nor failure may read
 * a policy scope the host has since disposed or report a late reconnect.
 */

type Listener = (event: { type: string; clientId?: string; error?: string }) => void

function fakeClient(connect: () => Promise<unknown>) {
	const listeners: Listener[] = []
	let connected = true
	const disconnect = vi.fn(async () => {
		connected = false
	})
	return {
		client: {
			isConnected: () => connected,
			connect: async () => {
				await connect()
				connected = true
			},
			disconnect,
			onLifecycle: (l: Listener) => {
				listeners.push(l)
				return () => {
					const i = listeners.indexOf(l)
					if (i >= 0) listeners.splice(i, 1)
				}
			},
		} as unknown as MCPClient,
		/** What the transport does when it dies. */
		drop(type = 'mcp_client_disconnected') {
			connected = false
			for (const l of [...listeners]) l({ type })
		},
		listenerCount: () => listeners.length,
		disconnect,
	}
}

describe('a transport that drops is reconnected', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('reconnects after the transport closes', async () => {
		const connect = vi.fn(async () => {})
		const { client, drop } = fakeClient(connect)
		new MCPReconnectSupervisor(client, { initialDelayMs: 10 }).start()

		drop()
		await vi.advanceTimersByTimeAsync(50)

		// Against the previous code this is 0: nothing retried, ever.
		expect(connect).toHaveBeenCalledTimes(1)
	})

	it('reconnects after a transport error too', async () => {
		const connect = vi.fn(async () => {})
		const { client, drop } = fakeClient(connect)
		new MCPReconnectSupervisor(client, { initialDelayMs: 10 }).start()

		drop('mcp_client_error')
		await vi.advanceTimersByTimeAsync(50)

		expect(connect).toHaveBeenCalledTimes(1)
	})

	it('backs off and gives up rather than retrying forever', async () => {
		const connect = vi.fn(async () => {
			throw new Error('still down')
		})
		const gaveUp = vi.fn()
		const { client, drop } = fakeClient(connect)
		new MCPReconnectSupervisor(client, {
			initialDelayMs: 10,
			maxDelayMs: 40,
			maxAttempts: 3,
			onGaveUp: gaveUp,
		}).start()

		drop()
		await vi.advanceTimersByTimeAsync(5_000)

		// Removing the `attempt <= maxAttempts` bound makes this unbounded and
		// the call count climbs with the clock.
		expect(connect).toHaveBeenCalledTimes(3)
		expect(gaveUp).toHaveBeenCalledWith(3)
	})

	it('does not reconnect what a host deliberately disconnected', async () => {
		// The whole hazard. `disconnect()` emits the same event, so the
		// supervisor has to be stopped first — and `stop()` has to take effect
		// even though the event still arrives.
		const connect = vi.fn(async () => {})
		const { client, drop } = fakeClient(connect)
		const supervisor = new MCPReconnectSupervisor(client, { initialDelayMs: 10 })
		supervisor.start()

		supervisor.stop()
		drop()
		await vi.advanceTimersByTimeAsync(200)

		expect(connect, 'a deliberately closed client was reopened').not.toHaveBeenCalled()
	})

	it('abandons a backoff already in flight when stopped', async () => {
		// Teardown must settle the pending wait, not only clear its timer.
		const connect = vi.fn(async () => {
			throw new Error('down')
		})
		const { client, drop } = fakeClient(connect)
		const supervisor = new MCPReconnectSupervisor(client, { initialDelayMs: 50, maxAttempts: 5 })
		supervisor.start()

		drop()
		await vi.advanceTimersByTimeAsync(60)
		expect(connect).toHaveBeenCalledTimes(1)

		supervisor.stop()
		await vi.advanceTimersByTimeAsync(0)
		expect(Reflect.get(supervisor, 'inFlight')).toBe(false)
		await vi.advanceTimersByTimeAsync(5_000)

		expect(connect).toHaveBeenCalledTimes(1)
	})

	it.each(['resolves', 'rejects'] as const)(
		'ignores a connect that %s after stop and policy disposal',
		async (outcome) => {
			let finishConnect: ((error?: Error) => void) | undefined
			const connect = vi.fn(
				() =>
					new Promise<void>((resolve, reject) => {
						finishConnect = (error) => (error ? reject(error) : resolve())
					}),
			)
			const onReconnected = vi.fn()
			let disposed = false
			const readPolicy = vi.fn(() => {
				if (disposed) throw new Error('policy scope disposed')
				return { initialDelayMs: 10, onReconnected }
			})
			const { client, drop, disconnect } = fakeClient(connect)
			const supervisor = new MCPReconnectSupervisor(client, readPolicy)
			supervisor.start()

			drop()
			await vi.advanceTimersByTimeAsync(10)
			expect(connect).toHaveBeenCalledTimes(1)
			const policyReadsBeforeStop = readPolicy.mock.calls.length

			supervisor.stop()
			await client.disconnect()
			disposed = true
			supervisor.start()
			finishConnect?.(outcome === 'rejects' ? new Error('late connect failure') : undefined)
			await vi.advanceTimersByTimeAsync(0)

			expect(readPolicy).toHaveBeenCalledTimes(policyReadsBeforeStop)
			expect(onReconnected).not.toHaveBeenCalled()
			expect(disconnect).toHaveBeenCalledTimes(2)
			expect(client.isConnected()).toBe(false)
			expect(Reflect.get(supervisor, 'inFlight')).toBe(false)
		},
	)

	it('runs one recovery when a failure emits both error and close', async () => {
		// A transport commonly reports both for the same fault. Two loops
		// would both call `connect()`, and the second lands on the
		// already-connected throw of the first one's success. Removing the
		// `inFlight` guard fails this.
		const connect = vi.fn(async () => {})
		const { client, drop } = fakeClient(connect)
		new MCPReconnectSupervisor(client, { initialDelayMs: 10 }).start()

		drop('mcp_client_error')
		drop('mcp_client_disconnected')
		await vi.advanceTimersByTimeAsync(200)

		expect(connect).toHaveBeenCalledTimes(1)
	})

	it('runs one recovery even when the reconnect itself is slow', async () => {
		// The test above is satisfied by the `isConnected()` check alone: with
		// an instant `connect`, the first loop has already flipped the flag by
		// the time the second looks. The `inFlight` guard is what covers the
		// real shape, where the reconnect is in flight while the second loop
		// wakes — both pass `isConnected()`, both call `connect()`, and the
		// second lands on the already-connected throw of the first one's
		// success. Removing `inFlight` fails this one and not the other.
		let resolveConnect: (() => void) | undefined
		const connect = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveConnect = resolve
				}),
		)
		const { client, drop } = fakeClient(connect)
		new MCPReconnectSupervisor(client, { initialDelayMs: 10 }).start()

		drop('mcp_client_error')
		drop('mcp_client_disconnected')
		await vi.advanceTimersByTimeAsync(100)

		expect(connect).toHaveBeenCalledTimes(1)
		resolveConnect?.()
	})

	it('tells the host when the connection came back', async () => {
		// A reconnected client is not a client that never dropped: its server
		// may have restarted with a different tool list. The supervisor cannot
		// know what to redo, so it reports when.
		const onReconnected = vi.fn()
		const { client, drop } = fakeClient(async () => {})
		new MCPReconnectSupervisor(client, { initialDelayMs: 10, onReconnected }).start()

		drop()
		await vi.advanceTimersByTimeAsync(50)

		expect(onReconnected).toHaveBeenCalledTimes(1)
	})

	it('is inert when disabled, and unsubscribes on stop', async () => {
		const connect = vi.fn(async () => {})
		const { client, drop, listenerCount } = fakeClient(connect)
		const off = new MCPReconnectSupervisor(client, { enabled: false })
		off.start()

		expect(listenerCount(), 'a disabled supervisor still subscribed').toBe(0)
		drop()
		await vi.advanceTimersByTimeAsync(200)
		expect(connect).not.toHaveBeenCalled()

		const on = new MCPReconnectSupervisor(client, { initialDelayMs: 10 })
		on.start()
		expect(listenerCount()).toBe(1)
		on.stop()
		expect(listenerCount(), 'stop left its listener behind').toBe(0)
	})
})
