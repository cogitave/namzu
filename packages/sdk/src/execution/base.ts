import { NAMZU } from '../constants/telemetry/index.js'
import type { ExecutionContextLifecycle, ExecutionEnvironment } from '../types/execution/index.js'
import { toErrorMessage } from '../utils/error.js'
import { SCOPE_ATTRIBUTE } from '../utils/log/types.js'
import { type Logger, resolveLogger } from '../utils/logger.js'

export interface BaseExecutionEvent {
	type: string
	contextId: string
	[key: string]: unknown
}

export type ExecutionEventListener = (event: BaseExecutionEvent) => void

type ExecutionLifecycleState =
	| 'idle'
	| 'initializing'
	| 'ready'
	| 'tearing-down'
	| 'teardown-failed'
	| 'torn-down'

class InitializationSupersededError extends Error {
	constructor(contextId: string) {
		super(`Execution context "${contextId}" initialization was superseded by teardown`)
		this.name = 'InitializationSupersededError'
	}
}

export abstract class BaseExecutionContext implements ExecutionContextLifecycle {
	abstract readonly id: string
	abstract readonly environment: ExecutionEnvironment

	protected log: Logger
	protected ready = false
	private listeners: ExecutionEventListener[] = []
	private lifecycleState: ExecutionLifecycleState = 'idle'
	private initializationOperation: Promise<void> | undefined
	private teardownOperation: Promise<void> | undefined

	constructor(log?: Logger) {
		this.log = resolveLogger(log).child({
			[SCOPE_ATTRIBUTE]: 'execution/base',
			[NAMZU.EXECUTION_TYPE]: this.constructor.name,
		})
	}

	initialize(): Promise<void> {
		if (this.lifecycleState === 'ready') return Promise.resolve()
		if (this.lifecycleState === 'initializing' && this.initializationOperation) {
			return this.initializationOperation
		}
		if (this.lifecycleState === 'tearing-down') {
			return Promise.reject(
				new Error(`Execution context "${this.id}" cannot initialize while teardown is in progress`),
			)
		}
		if (this.lifecycleState === 'teardown-failed') {
			return Promise.reject(
				new Error(
					`Execution context "${this.id}" cannot initialize until its failed teardown is retried`,
				),
			)
		}

		this.lifecycleState = 'initializing'
		const operation = this.performInitialize()
		this.initializationOperation = operation
		void operation.then(
			() => this.releaseInitialization(operation),
			() => this.releaseInitialization(operation),
		)
		return operation
	}

	private async performInitialize(): Promise<void> {
		try {
			await this.doInitialize()
			if (this.lifecycleState !== 'initializing') {
				throw new InitializationSupersededError(this.id)
			}
			this.ready = true
			this.lifecycleState = 'ready'
			this.log.info('Execution context initialized', {
				'namzu.execution.context_id': this.id,
				'namzu.execution.environment': this.environment,
			})
			this.emit({
				type: 'context_initialized',
				contextId: this.id,
				environment: this.environment,
			})
			if (this.lifecycleState !== 'ready') return
			this.emit({ type: 'context_ready', contextId: this.id })
		} catch (err) {
			if (err instanceof InitializationSupersededError) throw err
			this.ready = false
			if (this.lifecycleState === 'initializing') this.lifecycleState = 'idle'
			const message = toErrorMessage(err)
			this.emit({ type: 'context_error', contextId: this.id, error: message })
			this.log.error('Execution context initialization failed', {
				'namzu.execution.context_id': this.id,
				'exception.message': message,
			})
			throw err
		}
	}

	private releaseInitialization(operation: Promise<void>): void {
		if (this.initializationOperation === operation) this.initializationOperation = undefined
	}

	isReady(): boolean {
		return this.ready
	}

	teardown(): Promise<void> {
		if (this.lifecycleState === 'tearing-down' && this.teardownOperation) {
			return this.teardownOperation
		}
		if (this.lifecycleState === 'torn-down') return Promise.resolve()

		this.ready = false
		this.lifecycleState = 'tearing-down'
		const operation = this.performTeardown(this.initializationOperation)
		this.teardownOperation = operation
		void operation.then(
			() => this.releaseTeardown(operation),
			() => this.releaseTeardown(operation),
		)
		return operation
	}

	private async performTeardown(pendingInitialization: Promise<void> | undefined): Promise<void> {
		if (pendingInitialization) {
			try {
				await pendingInitialization
			} catch {
				// Initialization errors are reported by their owner. Cleanup still runs.
			}
		}

		try {
			await this.doTeardown()
			this.lifecycleState = 'torn-down'
			this.log.info('Execution context torn down', {
				'namzu.execution.context_id': this.id,
			})
			this.emit({ type: 'context_teardown', contextId: this.id })
		} catch (err) {
			this.lifecycleState = 'teardown-failed'
			const message = toErrorMessage(err)
			this.emit({ type: 'context_error', contextId: this.id, error: message })
			this.log.error('Execution context teardown failed', {
				'namzu.execution.context_id': this.id,
				'exception.message': message,
			})
			throw err
		}
	}

	private releaseTeardown(operation: Promise<void>): void {
		if (this.teardownOperation === operation) this.teardownOperation = undefined
	}

	on(listener: ExecutionEventListener): void {
		this.listeners.push(listener)
	}

	off(listener: ExecutionEventListener): void {
		const index = this.listeners.indexOf(listener)
		if (index >= 0) this.listeners.splice(index, 1)
	}

	protected emit(event: BaseExecutionEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch (err) {
				this.log.error('Execution context event listener error', {
					'exception.message': toErrorMessage(err),
				})
			}
		}
	}

	protected abstract doInitialize(): Promise<void>
	protected abstract doTeardown(): Promise<void>
}
