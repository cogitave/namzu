import type { ExecutionContextLifecycle, ExecutionEnvironment } from '../types/execution/index.js'
import { toErrorMessage } from '../utils/error.js'
import { type Logger, getRootLogger } from '../utils/logger.js'

export interface BaseExecutionEvent {
	type: string
	contextId: string
	[key: string]: unknown
}

export type ExecutionEventListener = (event: BaseExecutionEvent) => void

export abstract class BaseExecutionContext implements ExecutionContextLifecycle {
	abstract readonly id: string
	abstract readonly environment: ExecutionEnvironment

	protected log: Logger
	protected ready = false
	private listeners: ExecutionEventListener[] = []

	constructor() {
		this.log = getRootLogger().child({ component: this.constructor.name })
	}

	async initialize(): Promise<void> {
		try {
			await this.doInitialize()
			this.ready = true
			this.emit({ type: 'context_initialized', contextId: this.id, environment: this.environment })
			this.emit({ type: 'context_ready', contextId: this.id })
			this.log.info(`Execution context initialized: ${this.id} (${this.environment})`)
		} catch (err) {
			const message = toErrorMessage(err)
			this.emit({ type: 'context_error', contextId: this.id, error: message })
			this.log.error(`Execution context initialization failed: ${this.id}`, { error: message })
			throw err
		}
	}

	isReady(): boolean {
		return this.ready
	}

	async teardown(): Promise<void> {
		try {
			await this.doTeardown()
		} finally {
			this.ready = false
			this.emit({ type: 'context_teardown', contextId: this.id })
			this.log.info(`Execution context torn down: ${this.id}`)
		}
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
					error: toErrorMessage(err),
				})
			}
		}
	}

	protected abstract doInitialize(): Promise<void>
	protected abstract doTeardown(): Promise<void>
}
