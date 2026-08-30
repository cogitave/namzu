import { describe, expect, it } from 'vitest'

import type { ExecutionEnvironment } from '../types/execution/index.js'
import { BaseExecutionContext, type BaseExecutionEvent } from './base.js'

interface Deferred<T> {
	promise: Promise<T>
	resolve(value: T | PromiseLike<T>): void
	reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>['resolve']
	let reject!: Deferred<T>['reject']
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

class ControlledExecutionContext extends BaseExecutionContext {
	readonly id = 'controlled'
	readonly environment: ExecutionEnvironment = 'local'
	initializeCalls = 0
	teardownCalls = 0
	initializeHook: () => Promise<void> = () => Promise.resolve()
	teardownHook: () => Promise<void> = () => Promise.resolve()
	commitHook: () => void = () => {}
	admissionsOpen = true

	protected doInitialize(): Promise<void> {
		this.initializeCalls++
		return this.initializeHook()
	}

	protected doTeardown(): Promise<void> {
		this.teardownCalls++
		return this.teardownHook()
	}

	protected override onInitializationStarted(): void {
		this.admissionsOpen = false
	}

	protected override onInitializationCommitted(): void {
		this.commitHook()
		this.admissionsOpen = true
	}

	protected override onTeardownRequested(): void {
		this.admissionsOpen = false
	}
}

describe('BaseExecutionContext lifecycle ownership', () => {
	it('shares one initialization operation and publishes readiness once', async () => {
		const gate = deferred<void>()
		const context = new ControlledExecutionContext()
		const events: BaseExecutionEvent[] = []
		context.initializeHook = () => gate.promise
		context.on((event) => events.push(event))

		const first = context.initialize()
		const second = context.initialize()

		expect(second).toBe(first)
		expect(context.initializeCalls).toBe(1)
		expect(context.isReady()).toBe(false)
		expect(context.admissionsOpen).toBe(false)

		gate.resolve()
		await first

		expect(context.isReady()).toBe(true)
		expect(context.admissionsOpen).toBe(true)
		expect(events.map((event) => event.type)).toEqual(['context_initialized', 'context_ready'])
	})

	it('shares one teardown operation while cleanup is in progress', async () => {
		const gate = deferred<void>()
		const context = new ControlledExecutionContext()
		context.teardownHook = () => gate.promise

		const first = context.teardown()
		const second = context.teardown()

		expect(second).toBe(first)
		expect(context.teardownCalls).toBe(1)

		gate.resolve()
		await first
	})

	it('reports teardown failure without publishing success and permits a cleanup retry', async () => {
		const failure = new Error('cleanup failed')
		const context = new ControlledExecutionContext()
		const events: BaseExecutionEvent[] = []
		context.teardownHook = () =>
			context.teardownCalls === 1 ? Promise.reject(failure) : Promise.resolve()
		context.on((event) => events.push(event))

		await expect(context.teardown()).rejects.toBe(failure)

		expect(context.isReady()).toBe(false)
		expect(events).toContainEqual({
			type: 'context_error',
			contextId: context.id,
			error: failure.message,
		})
		expect(events.some((event) => event.type === 'context_teardown')).toBe(false)
		await expect(context.initialize()).rejects.toThrow('failed teardown is retried')

		await context.teardown()

		expect(context.teardownCalls).toBe(2)
		expect(events.filter((event) => event.type === 'context_teardown')).toHaveLength(1)
	})

	it('does not restore readiness when teardown supersedes initialization', async () => {
		const initialization = deferred<void>()
		const context = new ControlledExecutionContext()
		const events: BaseExecutionEvent[] = []
		context.initializeHook = () => initialization.promise
		context.on((event) => events.push(event))

		const initializing = context.initialize()
		const tearingDown = context.teardown()

		expect(context.isReady()).toBe(false)
		expect(context.admissionsOpen).toBe(false)
		expect(context.teardownCalls).toBe(0)
		initialization.resolve()

		await expect(initializing).rejects.toThrow('initialization was superseded by teardown')
		expect(context.admissionsOpen).toBe(false)
		await tearingDown

		expect(context.teardownCalls).toBe(1)
		expect(context.isReady()).toBe(false)
		expect(events.map((event) => event.type)).toEqual(['context_teardown'])
	})

	it('contains an initialization-commit hook failure in the shared lifecycle promise', async () => {
		const failure = new Error('commit fence failed')
		const context = new ControlledExecutionContext()
		context.commitHook = () => {
			throw failure
		}

		let initializing: Promise<void> | undefined
		expect(() => {
			initializing = context.initialize()
		}).not.toThrow()
		await expect(initializing).rejects.toBe(failure)
		expect(context.isReady()).toBe(false)
		expect(context.admissionsOpen).toBe(false)
	})

	it('does not publish ready when an initialized listener admits teardown', async () => {
		const context = new ControlledExecutionContext()
		const events: BaseExecutionEvent[] = []
		let tearingDown: Promise<void> | undefined
		context.on((event) => {
			events.push(event)
			if (event.type === 'context_initialized') tearingDown = context.teardown()
		})

		await context.initialize()
		await tearingDown

		expect(context.isReady()).toBe(false)
		expect(context.teardownCalls).toBe(1)
		expect(events.map((event) => event.type)).toEqual(['context_initialized', 'context_teardown'])
	})

	it('refuses initialization while teardown is in progress', async () => {
		const cleanup = deferred<void>()
		const context = new ControlledExecutionContext()
		context.teardownHook = () => cleanup.promise

		const tearingDown = context.teardown()

		await expect(context.initialize()).rejects.toThrow('teardown is in progress')
		expect(context.initializeCalls).toBe(0)

		cleanup.resolve()
		await tearingDown
	})

	it('is idempotent while ready and can initialize again after successful teardown', async () => {
		const context = new ControlledExecutionContext()
		const events: BaseExecutionEvent[] = []
		context.on((event) => events.push(event))

		await context.initialize()
		await context.initialize()
		expect(context.initializeCalls).toBe(1)

		await context.teardown()
		await context.teardown()
		expect(context.teardownCalls).toBe(1)

		await context.initialize()

		expect(context.initializeCalls).toBe(2)
		expect(context.isReady()).toBe(true)
		expect(events.filter((event) => event.type === 'context_initialized')).toHaveLength(2)
		expect(events.filter((event) => event.type === 'context_teardown')).toHaveLength(1)
	})
})
