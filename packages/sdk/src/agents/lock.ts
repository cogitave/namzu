/**
 * Invocation lock to prevent concurrent execution of the same agent instance.
 * Uses a simple boolean flag with RAII-style cleanup via Disposable pattern.
 */

export type ConcurrencyMode = 'throw' | 'queue'

export interface Disposable {
	[Symbol.dispose](): void
}

export class ConcurrentInvocationError extends Error {
	readonly agentId: string

	constructor(agentId: string) {
		super(`Agent ${agentId} is already processing. Concurrent invocations are not allowed.`)
		this.name = 'ConcurrentInvocationError'
		this.agentId = agentId
	}
}

/**
 * Simple lock mechanism to prevent concurrent invocations of the same agent.
 *
 * When the lock is acquired:
 * - Returns a Disposable object that releases the lock when disposed
 * - If already locked, throws ConcurrentInvocationError
 *
 * Usage with try/finally:
 * ```
 * const lock = this.invocationLock.acquire(agentId)
 * try {
 *   // do work
 * } finally {
 *   lock[Symbol.dispose]()
 * }
 * ```
 */
export class InvocationLock {
	private isLocked = false

	/**
	 * Acquire the lock. Returns a Disposable that releases the lock when disposed.
	 * @throws {ConcurrentInvocationError} if the lock is already held
	 */
	acquire(agentId: string): Disposable {
		if (this.isLocked) {
			throw new ConcurrentInvocationError(agentId)
		}

		this.isLocked = true

		return {
			[Symbol.dispose]: () => {
				this.isLocked = false
			},
		}
	}

	/**
	 * Check if the lock is currently active (held).
	 */
	isActive(): boolean {
		return this.isLocked
	}
}
