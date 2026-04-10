import {
	DEFAULT_BREAKER_FAILURE_THRESHOLD,
	DEFAULT_BREAKER_RESET_TIMEOUT_MS,
} from '../constants/bus/index.js'
import type {
	AgentBusEvent,
	CircuitBreakerSnapshot,
	CircuitBreakerState,
} from '../types/bus/index.js'
import type { RunId } from '../types/ids/index.js'
import type { Logger } from '../utils/logger.js'

interface MutableBreakerState {
	state: CircuitBreakerState
	agentRunId: RunId
	consecutiveFailures: number
	lastFailureAt?: number
	lastSuccessAt?: number
	trippedAt?: number
}

export class CircuitBreaker {
	private readonly breakers = new Map<string, MutableBreakerState>()
	private readonly failureThreshold: number
	private readonly resetTimeoutMs: number
	private readonly log: Logger
	private readonly emit: (event: AgentBusEvent) => void

	constructor(
		log: Logger,
		emit: (event: AgentBusEvent) => void,
		failureThreshold: number = DEFAULT_BREAKER_FAILURE_THRESHOLD,
		resetTimeoutMs: number = DEFAULT_BREAKER_RESET_TIMEOUT_MS,
	) {
		this.failureThreshold = failureThreshold
		this.resetTimeoutMs = resetTimeoutMs
		this.log = log.child({ component: 'CircuitBreaker' })
		this.emit = emit
	}

	canExecute(agentRunId: RunId): boolean {
		const breaker = this.breakers.get(agentRunId)
		if (!breaker) return true

		switch (breaker.state) {
			case 'closed':
				return true
			case 'open': {
				const elapsed = Date.now() - (breaker.trippedAt ?? 0)
				if (elapsed >= this.resetTimeoutMs) {
					breaker.state = 'half_open'
					this.log.info('circuit breaker transitioning to half_open', {
						agentRunId,
						elapsed,
					})
					this.emit({ type: 'breaker_half_open', agentRunId })
					return true
				}
				return false
			}
			case 'half_open':
				return true
			default: {
				const _exhaustive: never = breaker.state
				throw new Error(`Unhandled circuit breaker state: ${_exhaustive}`)
			}
		}
	}

	recordSuccess(agentRunId: RunId): void {
		const breaker = this.breakers.get(agentRunId)
		if (!breaker) return

		const previousState = breaker.state
		breaker.consecutiveFailures = 0
		breaker.lastSuccessAt = Date.now()

		switch (breaker.state) {
			case 'closed':
				break
			case 'half_open':
				breaker.state = 'closed'
				breaker.trippedAt = undefined
				this.log.info('circuit breaker reset after probe success', { agentRunId })
				this.emit({ type: 'breaker_probe_success', agentRunId })
				this.emit({ type: 'breaker_reset', agentRunId })
				break
			case 'open':
				this.log.warn('recordSuccess called while breaker is open', {
					agentRunId,
					previousState,
				})
				break
			default: {
				const _exhaustive: never = breaker.state
				throw new Error(`Unhandled circuit breaker state: ${_exhaustive}`)
			}
		}
	}

	recordFailure(agentRunId: RunId): void {
		let breaker = this.breakers.get(agentRunId)
		if (!breaker) {
			breaker = {
				state: 'closed',
				agentRunId,
				consecutiveFailures: 0,
			}
			this.breakers.set(agentRunId, breaker)
		}

		breaker.consecutiveFailures += 1
		breaker.lastFailureAt = Date.now()

		switch (breaker.state) {
			case 'closed':
				if (breaker.consecutiveFailures >= this.failureThreshold) {
					breaker.state = 'open'
					breaker.trippedAt = Date.now()
					this.log.warn('circuit breaker tripped', {
						agentRunId,
						consecutiveFailures: breaker.consecutiveFailures,
					})
					this.emit({
						type: 'breaker_tripped',
						agentRunId,
						consecutiveFailures: breaker.consecutiveFailures,
					})
				}
				break
			case 'half_open':
				breaker.state = 'open'
				breaker.trippedAt = Date.now()
				this.log.warn('circuit breaker re-tripped from half_open', { agentRunId })
				this.emit({ type: 'breaker_probe_failure', agentRunId })
				this.emit({
					type: 'breaker_tripped',
					agentRunId,
					consecutiveFailures: breaker.consecutiveFailures,
				})
				break
			case 'open':
				break
			default: {
				const _exhaustive: never = breaker.state
				throw new Error(`Unhandled circuit breaker state: ${_exhaustive}`)
			}
		}
	}

	getSnapshot(agentRunId: RunId): CircuitBreakerSnapshot | undefined {
		const breaker = this.breakers.get(agentRunId)
		if (!breaker) return undefined

		return {
			state: breaker.state,
			agentRunId: breaker.agentRunId,
			consecutiveFailures: breaker.consecutiveFailures,
			lastFailureAt: breaker.lastFailureAt,
			lastSuccessAt: breaker.lastSuccessAt,
			trippedAt: breaker.trippedAt,
		}
	}

	reset(agentRunId: RunId): void {
		const breaker = this.breakers.get(agentRunId)
		if (!breaker) return

		breaker.state = 'closed'
		breaker.consecutiveFailures = 0
		breaker.trippedAt = undefined
		this.log.info('circuit breaker manually reset', { agentRunId })
		this.emit({ type: 'breaker_reset', agentRunId })
	}

	listTripped(): CircuitBreakerSnapshot[] {
		const tripped: CircuitBreakerSnapshot[] = []
		for (const breaker of this.breakers.values()) {
			if (breaker.state === 'open' || breaker.state === 'half_open') {
				tripped.push({
					state: breaker.state,
					agentRunId: breaker.agentRunId,
					consecutiveFailures: breaker.consecutiveFailures,
					lastFailureAt: breaker.lastFailureAt,
					lastSuccessAt: breaker.lastSuccessAt,
					trippedAt: breaker.trippedAt,
				})
			}
		}
		return tripped
	}
}
