import type { MCPClient } from './client.js'

/**
 * Keeps an MCP connection alive across a transport that drops.
 *
 * `MCPClient.connect()` is called exactly once, by whoever built the client.
 * `transport.onClose` sets `status = 'disconnected'`, emits the lifecycle
 * event and rejects everything pending — and nothing in the module schedules
 * another attempt. So one blip, one server restart, one laptop sleep, and the
 * plugin's tools are gone for the rest of the process while the plugin itself
 * still reports as enabled: the failure is silent at the layer a host looks at.
 *
 * This is a supervisor rather than a retry inside `connect()` on purpose. A
 * caller awaiting `connect()` wants to know whether the first attempt worked;
 * burying an unbounded retry in it would turn a fast, actionable failure at
 * startup into a hang. Recovery after a connection that once succeeded is a
 * different question, and it belongs to a different object.
 */

/** How the supervisor backs off. Every field has a default. */
export interface MCPReconnectOptions {
	/** Defaults to true. `false` makes this object inert rather than absent. */
	readonly enabled?: boolean
	/** First wait, in ms. Defaults to 500. */
	readonly initialDelayMs?: number
	/** Ceiling for the exponential wait, in ms. Defaults to 30_000. */
	readonly maxDelayMs?: number
	/** Attempts before giving up. Defaults to 6. */
	readonly maxAttempts?: number
	/**
	 * Called after a reconnect succeeds.
	 *
	 * A reconnected client is not the same as one that never dropped: its
	 * server may have restarted with a different tool list, and every
	 * subscription the host made through `onNotification` was made against a
	 * transport that no longer exists. The supervisor cannot know what a host
	 * needs to redo, so it says when rather than guessing what.
	 */
	readonly onReconnected?: () => void | Promise<void>
	/** Called when the attempts are exhausted. */
	readonly onGaveUp?: (attempts: number) => void
}

const DEFAULTS = {
	enabled: true,
	initialDelayMs: 500,
	maxDelayMs: 30_000,
	maxAttempts: 6,
} as const

/**
 * Watches one client and reconnects it when its transport drops.
 *
 * ## Stop it before you disconnect deliberately
 *
 * `MCPClient.disconnect()` emits the same `mcp_client_disconnected` event the
 * transport does when it dies, and the event carries nothing that tells the
 * two apart. So a supervisor that is still attached when a host tears its
 * client down will read the teardown as a fault and reconnect the thing the
 * host just closed.
 *
 * `stop()` is therefore part of the teardown sequence, not an optimisation:
 * call it BEFORE `disconnect()`. The ordering is the contract because the
 * event cannot be, and widening the event to carry a cause would change a
 * published union for every consumer.
 */
export class MCPReconnectSupervisor {
	private readonly options: Required<Omit<MCPReconnectOptions, 'onReconnected' | 'onGaveUp'>> &
		Pick<MCPReconnectOptions, 'onReconnected' | 'onGaveUp'>
	private unsubscribe?: () => void
	private stopped = false
	private inFlight = false
	private timer?: ReturnType<typeof setTimeout>

	constructor(
		private readonly client: MCPClient,
		options: MCPReconnectOptions = {},
	) {
		this.options = { ...DEFAULTS, ...options }
	}

	/** Begin watching. Idempotent. */
	start(): void {
		if (!this.options.enabled || this.unsubscribe || this.stopped) return
		this.unsubscribe = this.client.onLifecycle((event) => {
			if (event.type !== 'mcp_client_disconnected' && event.type !== 'mcp_client_error') return
			void this.recover()
		})
	}

	/**
	 * Stop watching and cancel any pending attempt.
	 *
	 * Safe to call more than once, and safe to call from inside a reconnect —
	 * the loop checks `stopped` between waits, so a teardown during a backoff
	 * does not have to wait it out.
	 */
	stop(): void {
		this.stopped = true
		this.unsubscribe?.()
		this.unsubscribe = undefined
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
	}

	private async recover(): Promise<void> {
		// One recovery at a time. A transport can emit `error` and then
		// `close` for the same failure, and two overlapping loops would both
		// call `connect()` — the second landing on the "already connected"
		// throw of the first one's success.
		if (this.inFlight || this.stopped) return
		this.inFlight = true

		try {
			let delay = this.options.initialDelayMs
			for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
				if (this.stopped) return
				await this.wait(delay)
				if (this.stopped) return
				// Something else may have reconnected it while this waited —
				// a host retrying by hand, or a previous loop that had not yet
				// been observed. `connect()` throws when already connected, so
				// this asks rather than finding out by exception.
				if (this.client.isConnected()) return

				try {
					await this.client.connect()
					await this.options.onReconnected?.()
					return
				} catch {
					// Deliberately swallowed: a failed attempt is the normal
					// case here and the client has already logged and emitted
					// its own error. Re-raising would surface a routine retry
					// as an unhandled rejection from a timer.
					delay = Math.min(delay * 2, this.options.maxDelayMs)
				}
			}
			this.options.onGaveUp?.(this.options.maxAttempts)
		} finally {
			this.inFlight = false
		}
	}

	private wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.timer = setTimeout(resolve, ms)
		})
	}
}
