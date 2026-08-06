/**
 * Invocation lock to prevent concurrent execution of the same agent instance.
 * Uses a simple boolean flag with RAII-style cleanup via Disposable pattern.
 */

export interface Disposable {
	[Symbol.dispose](): void
}

export class ConcurrentInvocationError extends Error {
	readonly agentId: string

	constructor(agentId: string) {
		// Names the remedy, because the refusal alone sent readers looking for a
		// concurrency bug in their own code. An agent instance holds per-run
		// state — an abort controller and the run id — so two overlapping runs
		// on one shell would cancel each other; the answer is a second shell,
		// not a second attempt. Delegated spawns get one automatically via
		// `Agent.forRun`, so reaching this from a fan-out means the agent
		// could not be rebuilt and wants `AgentDefinition.createAgent`.
		super(
			`Agent ${agentId} is already processing. Concurrent invocations of one instance are not allowed, because its abort controller and run id are instance state and two runs would cancel each other. Run a second instance instead — or, for a delegated spawn, give its AgentDefinition a \`createAgent\` factory so each child gets its own.`,
		)
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
