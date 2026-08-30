import { describe, expect, it, vi } from 'vitest'

import type { RemoteTarget } from '../types/connector/index.js'
import type { BaseExecutionEvent } from './base.js'
import { HybridExecutionContext } from './hybrid.js'
import type { RemoteExecutionContext } from './remote.js'

interface Deferred<T> {
	promise: Promise<T>
	resolve(value: T | PromiseLike<T>): void
}

function deferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>['resolve']
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

function createContext(remoteCount = 1): HybridExecutionContext {
	const remotes: RemoteTarget[] = Array.from({ length: remoteCount }, (_, index) => ({
		type: 'ssh',
		host: `remote-${index}.example.com`,
	}))
	return new HybridExecutionContext({
		id: 'hybrid-lifecycle',
		local: { cwd: process.cwd() },
		remotes,
	})
}

function remoteAt(context: HybridExecutionContext, index: number): RemoteExecutionContext {
	const remote = context.getRemotes()[index]
	if (!remote) throw new Error(`Missing remote context at index ${index}`)
	return remote
}

describe('HybridExecutionContext teardown ownership', () => {
	it('starts local cleanup without waiting for a remote cleanup to settle', async () => {
		const remoteCleanup = deferred<void>()
		const context = createContext()
		const localTeardown = vi.spyOn(context.getLocal(), 'teardown').mockResolvedValue()
		const remoteTeardown = vi
			.spyOn(remoteAt(context, 0), 'teardown')
			.mockReturnValue(remoteCleanup.promise)

		const tearingDown = context.teardown()

		expect(remoteTeardown).toHaveBeenCalledOnce()
		expect(localTeardown).toHaveBeenCalledOnce()

		remoteCleanup.resolve()
		await tearingDown
	})

	it('surfaces one child failure by identity and does not publish hybrid success', async () => {
		const failure = new Error('remote cleanup failed')
		const context = createContext()
		const events: BaseExecutionEvent[] = []
		vi.spyOn(context.getLocal(), 'teardown').mockResolvedValue()
		vi.spyOn(remoteAt(context, 0), 'teardown').mockRejectedValue(failure)
		context.on((event) => events.push(event))

		await expect(context.teardown()).rejects.toBe(failure)

		expect(
			events.some((event) => event.contextId === context.id && event.type === 'context_teardown'),
		).toBe(false)
		expect(events).toContainEqual({
			type: 'context_error',
			contextId: context.id,
			error: failure.message,
		})
	})

	it('reports every child failure in stable child order', async () => {
		const localFailure = new Error('local cleanup failed')
		const remoteFailure = new Error('remote cleanup failed')
		const context = createContext(2)
		vi.spyOn(context.getLocal(), 'teardown').mockRejectedValue(localFailure)
		vi.spyOn(remoteAt(context, 0), 'teardown').mockRejectedValue(remoteFailure)
		const finalRemoteTeardown = vi.spyOn(remoteAt(context, 1), 'teardown').mockResolvedValue()

		const caught = await context.teardown().catch((error: unknown) => error)

		expect(finalRemoteTeardown).toHaveBeenCalledOnce()
		expect(caught).toBeInstanceOf(AggregateError)
		expect((caught as AggregateError).errors).toEqual([localFailure, remoteFailure])
	})
})
