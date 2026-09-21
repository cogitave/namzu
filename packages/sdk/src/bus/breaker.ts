import {
	DEFAULT_BREAKER_FAILURE_THRESHOLD,
	DEFAULT_BREAKER_RESET_TIMEOUT_MS,
} from '../constants/bus/index.js'
import { NAMZU } from '../constants/telemetry/index.js'
import type {
	AgentBusEvent,
	CircuitBreakerSnapshot,
	CircuitBreakerState,
} from '../types/bus/index.js'
import type { SessionId } from '../types/ids/index.js'
import { SCOPE_ATTRIBUTE } from '../utils/log/types.js'
import type { Logger } from '../utils/logger.js'

interface MutableBreakerState {
	state: CircuitBreakerState
	agentSessionId: SessionId
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
		this.log = log.child({ [SCOPE_ATTRIBUTE]: 'bus/breaker' })
		this.emit = emit
	}

	canExecute(agentSessionId: SessionId): boolean {
		const breaker = this.breakers.get(agentSessionId)
		if (!breaker) return true

		switch (breaker.state) {
			case 'closed':
				return true
			case 'open': {
				const elapsed = Date.now() - (breaker.trippedAt ?? 0)
				if (elapsed >= this.resetTimeoutMs) {
					breaker.state = 'half_open'
					this.log.info('circuit breaker transitioning to half_open', {
						[NAMZU.SESSION_ID]: agentSessionId,
						'namzu.bus.elapsed': elapsed,
					})
					this.emit({ type: 'breaker_half_open', agentSessionId })
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

	recordSuccess(agentSessionId: SessionId): void {
		const breaker = this.breakers.get(agentSessionId)
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
				this.log.info('circuit breaker reset after probe success', {
					[NAMZU.SESSION_ID]: agentSessionId,
				})
				this.emit({ type: 'breaker_probe_success', agentSessionId })
				this.emit({ type: 'breaker_reset', agentSessionId })
				break
			case 'open':
				this.log.warn('recordSuccess called while breaker is open', {
					[NAMZU.SESSION_ID]: agentSessionId,
					'namzu.bus.previous_state': previousState,
				})
				break
			default: {
				const _exhaustive: never = breaker.state
				throw new Error(`Unhandled circuit breaker state: ${_exhaustive}`)
			}
		}
	}

	recordFailure(agentSessionId: SessionId): void {
		let breaker = this.breakers.get(agentSessionId)
		if (!breaker) {
			breaker = {
				state: 'closed',
				agentSessionId,
				consecutiveFailures: 0,
			}
			this.breakers.set(agentSessionId, breaker)
		}

		breaker.consecutiveFailures += 1
		breaker.lastFailureAt = Date.now()

		switch (breaker.state) {
			case 'closed':
				if (breaker.consecutiveFailures >= this.failureThreshold) {
					breaker.state = 'open'
					breaker.trippedAt = Date.now()
					this.log.warn('circuit breaker tripped', {
						[NAMZU.SESSION_ID]: agentSessionId,
						'namzu.bus.consecutive_failures': breaker.consecutiveFailures,
					})
					this.emit({
						type: 'breaker_tripped',
						agentSessionId,
						consecutiveFailures: breaker.consecutiveFailures,
					})
				}
				break
			case 'half_open':
				breaker.state = 'open'
				breaker.trippedAt = Date.now()
				this.log.warn('circuit breaker re-tripped from half_open', {
					[NAMZU.SESSION_ID]: agentSessionId,
				})
				this.emit({ type: 'breaker_probe_failure', agentSessionId })
				this.emit({
					type: 'breaker_tripped',
					agentSessionId,
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

	getSnapshot(agentSessionId: SessionId): CircuitBreakerSnapshot | undefined {
		const breaker = this.breakers.get(agentSessionId)
		if (!breaker) return undefined

		return {
			state: breaker.state,
			agentSessionId: breaker.agentSessionId,
			consecutiveFailures: breaker.consecutiveFailures,
			lastFailureAt: breaker.lastFailureAt,
			lastSuccessAt: breaker.lastSuccessAt,
			trippedAt: breaker.trippedAt,
		}
	}

	reset(agentSessionId: SessionId): void {
		const breaker = this.breakers.get(agentSessionId)
		if (!breaker) return

		breaker.state = 'closed'
		breaker.consecutiveFailures = 0
		breaker.trippedAt = undefined
		this.log.info('circuit breaker manually reset', { [NAMZU.SESSION_ID]: agentSessionId })
		this.emit({ type: 'breaker_reset', agentSessionId })
	}

	listTripped(): CircuitBreakerSnapshot[] {
		const tripped: CircuitBreakerSnapshot[] = []
		for (const breaker of this.breakers.values()) {
			if (breaker.state === 'open' || breaker.state === 'half_open') {
				tripped.push({
					state: breaker.state,
					agentSessionId: breaker.agentSessionId,
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
