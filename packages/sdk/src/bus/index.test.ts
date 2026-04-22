/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 1):
 *
 *   - `AgentBus` composes a `FileLockManager`, `EditOwnershipTracker`,
 *     and `CircuitBreaker`; every event each of them emits is
 *     broadcast to bus-level listeners.
 *   - `on(listener)` returns an unsubscribe function; invoking it
 *     removes the listener, and subsequent events skip it.
 *   - Listeners receive events in the order they are emitted
 *     (preserved by `Set` insertion-order iteration). Multi-listener
 *     fan-out: every listener sees every event.
 *   - A throwing listener does NOT cascade — other listeners still
 *     receive the same event, and the bus logs the error via
 *     `log.error`.
 *   - No per-tenant routing — events are global to the bus instance
 *     (design.md §2.1 aspirational per-tenant ordering does not
 *     exist; see §2.7).
 *   - `cleanupAgent(runId)` releases every lock + every ownership +
 *     resets the breaker for that runId. Counts are logged; the
 *     method does not return them.
 *   - `maintenance()` expires stale locks via `locks.expireStale()`
 *     and logs the count when non-zero.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentBusEvent } from '../types/bus/index.js'
import type { RunId } from '../types/ids/index.js'
import type { Logger } from '../utils/logger.js'

import { AgentBus } from './index.js'

function makeLogger(): Logger {
	// Recursive self-returning child — AgentBus nests FileLockManager /
	// EditOwnershipTracker / CircuitBreaker, each of which chains a
	// `log.child(...)` call in its constructor.
	const self = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn(),
	} as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

function runId(n: number): RunId {
	return `run_${n}` as RunId
}

describe('AgentBus', () => {
	let bus: AgentBus
	let log: Logger

	beforeEach(() => {
		log = makeLogger()
		bus = new AgentBus(log, { lockTimeoutMs: 60_000, lockAcquireTimeoutMs: 60 })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe('listener lifecycle', () => {
		it('broadcasts events to every registered listener', async () => {
			const a: AgentBusEvent[] = []
			const b: AgentBusEvent[] = []
			bus.on((e) => a.push(e))
			bus.on((e) => b.push(e))

			await bus.locks.acquire('/tmp/f.txt', runId(1))

			expect(a.length).toBeGreaterThan(0)
			expect(b).toEqual(a)
		})

		it('unsubscribe removes the listener; later events skip it', async () => {
			const seen: AgentBusEvent[] = []
			const off = bus.on((e) => seen.push(e))

			await bus.locks.acquire('/tmp/a.txt', runId(1))
			const countAfterFirst = seen.length
			expect(countAfterFirst).toBeGreaterThan(0)

			off()
			await bus.locks.acquire('/tmp/b.txt', runId(1))
			expect(seen.length).toBe(countAfterFirst)
		})

		it('preserves emission order per listener (Set insertion-order iteration)', async () => {
			const seen: string[] = []
			bus.on((e) => seen.push(e.type))

			await bus.locks.acquire('/tmp/a.txt', runId(1))
			bus.ownership.claim('/tmp/a.txt', runId(1))
			bus.ownership.release('/tmp/a.txt', runId(1))
			bus.locks.release('/tmp/a.txt', runId(1))

			expect(seen).toEqual([
				'lock_acquired',
				'ownership_claimed',
				'ownership_released',
				'lock_released',
			])
		})

		it('a throwing listener does not cascade — other listeners still fire', async () => {
			const good: AgentBusEvent[] = []
			bus.on(() => {
				throw new Error('boom')
			})
			bus.on((e) => good.push(e))

			await bus.locks.acquire('/tmp/a.txt', runId(1))
			expect(good.length).toBeGreaterThan(0)
		})
	})

	describe('composed sub-components', () => {
		it('CircuitBreaker events flow through the bus listener', () => {
			const seen: AgentBusEvent[] = []
			bus.on((e) => seen.push(e))

			for (let i = 0; i < 5; i++) bus.breaker.recordFailure(runId(1))
			expect(seen.filter((e) => e.type === 'breaker_tripped')).toHaveLength(1)
		})

		it('EditOwnershipTracker events flow through the bus listener', () => {
			const seen: AgentBusEvent[] = []
			bus.on((e) => seen.push(e))

			bus.ownership.claim('/tmp/a.txt', runId(1))
			bus.ownership.transfer('/tmp/a.txt', runId(1), runId(2))
			bus.ownership.release('/tmp/a.txt', runId(2))

			expect(seen.map((e) => e.type)).toEqual([
				'ownership_claimed',
				'ownership_transferred',
				'ownership_released',
			])
		})
	})

	describe('cleanupAgent', () => {
		it('releases locks + ownerships + resets breaker for the runId', async () => {
			await bus.locks.acquire('/tmp/a.txt', runId(1))
			bus.ownership.claim('/tmp/a.txt', runId(1))
			for (let i = 0; i < 5; i++) bus.breaker.recordFailure(runId(1))
			expect(bus.breaker.getSnapshot(runId(1))?.state).toBe('open')
			expect(bus.locks.isLocked('/tmp/a.txt')).toBe(true)

			bus.cleanupAgent(runId(1))

			expect(bus.locks.isLocked('/tmp/a.txt')).toBe(false)
			expect(bus.ownership.getOwner('/tmp/a.txt')).toBeUndefined()
			expect(bus.breaker.getSnapshot(runId(1))?.state).toBe('closed')
		})

		it('does not affect other runIds', async () => {
			await bus.locks.acquire('/tmp/a.txt', runId(1))
			await bus.locks.acquire('/tmp/b.txt', runId(2))

			bus.cleanupAgent(runId(1))

			expect(bus.locks.isLocked('/tmp/a.txt')).toBe(false)
			expect(bus.locks.isLocked('/tmp/b.txt')).toBe(true)
			expect(bus.locks.getHolder('/tmp/b.txt')).toBe(runId(2))
		})
	})

	describe('maintenance', () => {
		it('sweeps expired locks', async () => {
			vi.useFakeTimers()
			const b = new AgentBus(makeLogger(), { lockTimeoutMs: 500, lockAcquireTimeoutMs: 30 })
			await b.locks.acquire('/tmp/a.txt', runId(1))
			vi.advanceTimersByTime(501)

			b.maintenance()
			expect(b.locks.isLocked('/tmp/a.txt')).toBe(false)
		})
	})
})
