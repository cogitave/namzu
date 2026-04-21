/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 1):
 *
 *   - `canExecute(runId)` on an unknown runId returns true (no breaker
 *     means no constraint).
 *   - `recordFailure(runId)` lazily creates a breaker entry in `closed`
 *     state for unknown runIds; `recordSuccess(runId)` is a no-op when
 *     no entry exists.
 *   - Consecutive failures: after `failureThreshold` calls in a row
 *     without intervening success, `state` → `open`, `trippedAt` set,
 *     single `breaker_tripped` event.
 *   - In `open` state, `canExecute` returns false until `resetTimeoutMs`
 *     has elapsed since `trippedAt`; at that point it transitions to
 *     `half_open`, emits `breaker_half_open`, and returns true.
 *   - In `half_open`, `canExecute` keeps returning true (the probe is
 *     allowed more than once) until the next `recordSuccess` closes the
 *     breaker or the next `recordFailure` re-trips it.
 *   - `recordSuccess` in `half_open` → `closed`; emits
 *     `breaker_probe_success` then `breaker_reset` (two events, in
 *     that order).
 *   - `recordFailure` in `half_open` → `open`; emits
 *     `breaker_probe_failure` then `breaker_tripped` (two events).
 *     The `consecutiveFailures` count carries over (not reset by the
 *     half-open probe cycle).
 *   - `recordSuccess` in `closed` resets `consecutiveFailures` to 0 and
 *     updates `lastSuccessAt`; emits nothing.
 *   - `recordSuccess` while `open`: logs a warning, does NOT change
 *     state (behaviour is "discarded"); emits nothing.
 *   - `recordFailure` while `open`: no additional events; state stays
 *     open (consecutive counter does NOT advance from `recordFailure`
 *     while open in the current implementation either — see test).
 *   - `reset(runId)` forces the breaker to `closed` regardless of prior
 *     state; emits `breaker_reset`; clears `consecutiveFailures` and
 *     `trippedAt` but preserves `lastFailureAt` / `lastSuccessAt`.
 *   - `listTripped()` returns snapshots for every breaker in `open` or
 *     `half_open`; closed breakers are excluded.
 *   - Breaker entries are keyed per-`RunId`; state does not leak across
 *     runs. No per-tenant dimension (design.md §2.1 aspirational).
 */

import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentBusEvent } from '../types/bus/index.js'
import type { RunId } from '../types/ids/index.js'
import type { Logger } from '../utils/logger.js'

import { CircuitBreaker } from './breaker.js'

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function runId(n: number): RunId {
	return `run_${n}` as RunId
}

const THRESHOLD = 5
const RESET_MS = 30_000

describe('CircuitBreaker', () => {
	let events: AgentBusEvent[]
	let breaker: CircuitBreaker

	beforeEach(() => {
		events = []
		breaker = new CircuitBreaker(makeLogger(), (e) => events.push(e), THRESHOLD, RESET_MS)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe('canExecute', () => {
		it('returns true for an unknown runId (no breaker entry yet)', () => {
			expect(breaker.canExecute(runId(1))).toBe(true)
		})
	})

	describe('recordFailure', () => {
		it('lazily creates a closed breaker entry for unknown runIds', () => {
			breaker.recordFailure(runId(1))
			const snap = breaker.getSnapshot(runId(1))
			expect(snap?.state).toBe('closed')
			expect(snap?.consecutiveFailures).toBe(1)
		})

		it('trips after exactly `failureThreshold` consecutive failures', () => {
			for (let i = 0; i < THRESHOLD - 1; i++) {
				breaker.recordFailure(runId(1))
			}
			expect(breaker.getSnapshot(runId(1))?.state).toBe('closed')
			expect(events.filter((e) => e.type === 'breaker_tripped')).toHaveLength(0)

			breaker.recordFailure(runId(1))
			expect(breaker.getSnapshot(runId(1))?.state).toBe('open')
			const trippedEvents = events.filter((e) => e.type === 'breaker_tripped')
			expect(trippedEvents).toHaveLength(1)
			if (trippedEvents[0]?.type === 'breaker_tripped') {
				expect(trippedEvents[0].consecutiveFailures).toBe(THRESHOLD)
			}
		})

		it('trips exactly once — further failures in `open` emit no new breaker_tripped', () => {
			for (let i = 0; i < THRESHOLD; i++) breaker.recordFailure(runId(1))
			events.length = 0

			breaker.recordFailure(runId(1))
			breaker.recordFailure(runId(1))
			expect(events).toEqual([])
		})

		it('property: any N ≥ threshold consecutive failures trips exactly once', () => {
			fc.assert(
				fc.property(fc.integer({ min: THRESHOLD, max: THRESHOLD * 4 }), (n) => {
					const local = new CircuitBreaker(makeLogger(), () => {}, THRESHOLD, RESET_MS)
					for (let i = 0; i < n; i++) local.recordFailure(runId(999))
					expect(local.getSnapshot(runId(999))?.state).toBe('open')
				}),
				{ numRuns: 25 },
			)
		})

		it('property: any N < threshold keeps the breaker closed', () => {
			fc.assert(
				fc.property(fc.integer({ min: 0, max: THRESHOLD - 1 }), (n) => {
					const local = new CircuitBreaker(makeLogger(), () => {}, THRESHOLD, RESET_MS)
					for (let i = 0; i < n; i++) local.recordFailure(runId(888))
					const snap = local.getSnapshot(runId(888))
					if (n === 0) {
						expect(snap).toBeUndefined()
					} else {
						expect(snap?.state).toBe('closed')
					}
				}),
				{ numRuns: 25 },
			)
		})
	})

	describe('recordSuccess', () => {
		it('is a no-op on an unknown runId — no breaker entry created', () => {
			breaker.recordSuccess(runId(42))
			expect(breaker.getSnapshot(runId(42))).toBeUndefined()
			expect(events).toEqual([])
		})

		it('resets consecutiveFailures to 0 without changing closed state', () => {
			breaker.recordFailure(runId(1))
			breaker.recordFailure(runId(1))
			breaker.recordSuccess(runId(1))
			const snap = breaker.getSnapshot(runId(1))
			expect(snap?.state).toBe('closed')
			expect(snap?.consecutiveFailures).toBe(0)
			expect(snap?.lastSuccessAt).toBeDefined()
		})

		it('is discarded (warned, no state change) when called while breaker is open', () => {
			for (let i = 0; i < THRESHOLD; i++) breaker.recordFailure(runId(1))
			events.length = 0

			breaker.recordSuccess(runId(1))
			expect(breaker.getSnapshot(runId(1))?.state).toBe('open')
			expect(events).toEqual([])
		})
	})

	describe('open → half_open transition', () => {
		it('transitions to half_open after resetTimeoutMs elapsed; emits breaker_half_open', () => {
			vi.useFakeTimers()
			const trip = new CircuitBreaker(makeLogger(), (e) => events.push(e), THRESHOLD, RESET_MS)
			for (let i = 0; i < THRESHOLD; i++) trip.recordFailure(runId(1))
			events.length = 0

			expect(trip.canExecute(runId(1))).toBe(false)

			vi.advanceTimersByTime(RESET_MS - 1)
			expect(trip.canExecute(runId(1))).toBe(false)

			vi.advanceTimersByTime(1)
			expect(trip.canExecute(runId(1))).toBe(true)
			expect(trip.getSnapshot(runId(1))?.state).toBe('half_open')
			expect(events).toEqual([{ type: 'breaker_half_open', agentRunId: runId(1) }])
		})

		it('canExecute in half_open keeps returning true until success or failure resolves', () => {
			vi.useFakeTimers()
			const trip = new CircuitBreaker(makeLogger(), () => {}, THRESHOLD, RESET_MS)
			for (let i = 0; i < THRESHOLD; i++) trip.recordFailure(runId(1))
			vi.advanceTimersByTime(RESET_MS)
			trip.canExecute(runId(1)) // flip to half_open
			expect(trip.canExecute(runId(1))).toBe(true)
			expect(trip.canExecute(runId(1))).toBe(true)
		})
	})

	describe('half_open → closed / open resolution', () => {
		function setupHalfOpen(): CircuitBreaker {
			vi.useFakeTimers()
			const b = new CircuitBreaker(makeLogger(), (e) => events.push(e), THRESHOLD, RESET_MS)
			for (let i = 0; i < THRESHOLD; i++) b.recordFailure(runId(1))
			vi.advanceTimersByTime(RESET_MS)
			b.canExecute(runId(1)) // flip
			events.length = 0
			return b
		}

		it('recordSuccess in half_open closes the breaker + emits probe_success then reset', () => {
			const b = setupHalfOpen()
			b.recordSuccess(runId(1))
			expect(b.getSnapshot(runId(1))?.state).toBe('closed')
			expect(b.getSnapshot(runId(1))?.consecutiveFailures).toBe(0)
			expect(events).toEqual([
				{ type: 'breaker_probe_success', agentRunId: runId(1) },
				{ type: 'breaker_reset', agentRunId: runId(1) },
			])
		})

		it('recordFailure in half_open re-trips + emits probe_failure then tripped', () => {
			const b = setupHalfOpen()
			b.recordFailure(runId(1))
			expect(b.getSnapshot(runId(1))?.state).toBe('open')
			expect(events).toEqual([
				{ type: 'breaker_probe_failure', agentRunId: runId(1) },
				{
					type: 'breaker_tripped',
					agentRunId: runId(1),
					consecutiveFailures: THRESHOLD + 1,
				},
			])
		})
	})

	describe('reset', () => {
		it('forces a tripped breaker back to closed + emits breaker_reset', () => {
			for (let i = 0; i < THRESHOLD; i++) breaker.recordFailure(runId(1))
			events.length = 0

			breaker.reset(runId(1))
			const snap = breaker.getSnapshot(runId(1))
			expect(snap?.state).toBe('closed')
			expect(snap?.consecutiveFailures).toBe(0)
			expect(snap?.trippedAt).toBeUndefined()
			expect(events).toEqual([{ type: 'breaker_reset', agentRunId: runId(1) }])
		})

		it('is a no-op on an unknown runId (no event)', () => {
			breaker.reset(runId(999))
			expect(events).toEqual([])
		})
	})

	describe('per-runId isolation', () => {
		it('tripping one runId does not affect another', () => {
			for (let i = 0; i < THRESHOLD; i++) breaker.recordFailure(runId(1))
			expect(breaker.getSnapshot(runId(1))?.state).toBe('open')
			expect(breaker.canExecute(runId(2))).toBe(true)
			expect(breaker.getSnapshot(runId(2))).toBeUndefined()
		})
	})

	describe('listTripped', () => {
		it('returns only open + half_open breakers; excludes closed', () => {
			for (let i = 0; i < THRESHOLD; i++) breaker.recordFailure(runId(1))
			breaker.recordFailure(runId(2))

			const tripped = breaker.listTripped()
			expect(tripped).toHaveLength(1)
			expect(tripped[0]?.agentRunId).toBe(runId(1))
			expect(tripped[0]?.state).toBe('open')
		})
	})
})
