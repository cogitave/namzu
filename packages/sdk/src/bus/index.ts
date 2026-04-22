import {
	DEFAULT_BREAKER_FAILURE_THRESHOLD,
	DEFAULT_BREAKER_RESET_TIMEOUT_MS,
	DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
	DEFAULT_LOCK_TIMEOUT_MS,
	DEFAULT_MAX_LOCKS_PER_AGENT,
} from '../constants/bus/index.js'
import { buildProbeContext } from '../probe/context.js'
import { type ProbeRegistry, probe as defaultProbeRegistry } from '../probe/registry.js'
import type { AgentBusEvent, AgentBusEventListener } from '../types/bus/index.js'
import type { RunId } from '../types/ids/index.js'
import type { Logger } from '../utils/logger.js'

import { CircuitBreaker } from './breaker.js'
import { FileLockManager } from './lock.js'
import { EditOwnershipTracker } from './ownership.js'

export interface AgentBusConfig {
	enabled: boolean
	lockTimeoutMs: number
	lockAcquireTimeoutMs: number
	maxLocksPerAgent: number
	breakerFailureThreshold: number
	breakerResetTimeoutMs: number
}

const DEFAULT_AGENT_BUS_CONFIG: AgentBusConfig = {
	enabled: true,
	lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
	lockAcquireTimeoutMs: DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
	maxLocksPerAgent: DEFAULT_MAX_LOCKS_PER_AGENT,
	breakerFailureThreshold: DEFAULT_BREAKER_FAILURE_THRESHOLD,
	breakerResetTimeoutMs: DEFAULT_BREAKER_RESET_TIMEOUT_MS,
}

export class AgentBus {
	readonly locks: FileLockManager
	readonly ownership: EditOwnershipTracker
	readonly breaker: CircuitBreaker

	private readonly listeners: Set<AgentBusEventListener> = new Set()
	private readonly log: Logger
	private readonly config: AgentBusConfig
	private readonly probes: ProbeRegistry

	constructor(
		log: Logger,
		config: Partial<AgentBusConfig> = {},
		probeRegistry: ProbeRegistry = defaultProbeRegistry,
	) {
		this.config = { ...DEFAULT_AGENT_BUS_CONFIG, ...config }
		this.log = log.child({ component: 'AgentBus' })
		this.probes = probeRegistry
		this.probes.setLogger(log)

		const emitFn = (event: AgentBusEvent): void => this.emit(event)

		this.locks = new FileLockManager(this.log, emitFn, {
			lockTimeoutMs: this.config.lockTimeoutMs,
			acquireTimeoutMs: this.config.lockAcquireTimeoutMs,
			maxLocksPerAgent: this.config.maxLocksPerAgent,
		})

		this.ownership = new EditOwnershipTracker(this.log, emitFn)

		this.breaker = new CircuitBreaker(
			this.log,
			emitFn,
			this.config.breakerFailureThreshold,
			this.config.breakerResetTimeoutMs,
		)
	}

	on(listener: AgentBusEventListener): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	private emit(event: AgentBusEvent): void {
		this.probes.dispatch(event, buildProbeContext(), () => {
			for (const listener of this.listeners) {
				try {
					listener(event)
				} catch (error) {
					this.log.error('event listener threw', {
						eventType: event.type,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			}
		})
	}

	cleanupAgent(runId: RunId): void {
		this.log.info('cleaning up agent resources', { runId })
		const locksReleased = this.locks.releaseAll(runId)
		const ownershipsReleased = this.ownership.releaseAll(runId)
		this.breaker.reset(runId)

		this.log.info('agent cleanup complete', {
			runId,
			locksReleased,
			ownershipsReleased,
		})
	}

	maintenance(): void {
		const expired = this.locks.expireStale()
		if (expired > 0) {
			this.log.info('maintenance: expired stale locks', { count: expired })
		}
	}
}

export { CircuitBreaker } from './breaker.js'
export { FileLockManager } from './lock.js'
export type { FileLockManagerConfig } from './lock.js'
export { EditOwnershipTracker } from './ownership.js'
export type {
	AgentBusEvent,
	AgentBusEventListener,
	CircuitBreakerSnapshot,
	CircuitBreakerState,
	FileLock,
	FileOwnership,
	LockAcquireResult,
	LockId,
	OwnershipClaimResult,
} from '../types/bus/index.js'
