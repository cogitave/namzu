/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 1):
 *
 *   - `acquire(path, owner)` returns immediately when the file is
 *     unlocked; creates a lock with `lockId = lock_<uuid>`,
 *     `expiresAt = now + lockTimeoutMs`, emits `lock_acquired`.
 *   - `acquire` on a file already held by the SAME owner is idempotent
 *     — returns `{acquired: true, lock}` (the existing lock) and emits
 *     nothing.
 *   - `acquire` on a file held by a DIFFERENT owner emits `lock_denied`
 *     and then polls at `LOCK_ACQUIRE_POLL_INTERVAL_MS` (100ms) intervals
 *     until either the holder releases, the lock expires, or
 *     `acquireTimeoutMs` elapses. No FIFO queue; retries race.
 *   - When the holder releases before the deadline, the waiting acquire
 *     succeeds on its next poll.
 *   - When `acquireTimeoutMs` elapses, acquire returns
 *     `{acquired: false, holder, filePath}` — holder is the current
 *     lock holder's owner if the lock still exists, else empty string.
 *   - `maxLocksPerAgent` blocks further acquisitions by the same owner.
 *     The internal `tryAcquire` returns `{holder: owner}` (a
 *     "yourself" sentinel) but the public `acquire()` swallows that and
 *     keeps polling for `acquireTimeoutMs` (there's no short-circuit
 *     for cap-exceeded). When the deadline expires and no lock exists
 *     on the file, the final `holder` is `''` (empty `RunId`) because
 *     the fallback reads `this.locks.get(filePath)?.owner ?? ''`.
 *   - `release(path, owner)` deletes the lock + emits `lock_released`
 *     when the current lock's owner matches; cleans up the per-owner
 *     lock set (and prunes the set entry when it becomes empty).
 *     Returns false without emitting when no lock or owner mismatch.
 *   - `releaseAll(owner)` drops every lock owned by `owner`, emits
 *     `lock_released` per lock, returns the count, and prunes the
 *     per-owner set.
 *   - `isLocked(path)` + `getHolder(path)` auto-expire any stale lock
 *     they observe (and emit `lock_expired`) before returning the
 *     current state.
 *   - `expireStale()` sweeps every lock; expired ones are deleted and
 *     emit `lock_expired`; returns the count.
 *   - Re-acquiring a path after its lock expires succeeds and assigns
 *     a FRESH `lockId` (the old id is never reused).
 *   - Lock state is per-`RunId`; no tenant dimension (design.md §2.1
 *     aspirational).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentBusEvent } from '../types/bus/index.js'
import type { RunId } from '../types/ids/index.js'
import type { Logger } from '../utils/logger.js'

import { FileLockManager } from './lock.js'

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function runId(n: number): RunId {
	return `run_${n}` as RunId
}

function makeManager(
	overrides: Partial<{
		lockTimeoutMs: number
		acquireTimeoutMs: number
		maxLocksPerAgent: number
	}> = {},
) {
	const events: AgentBusEvent[] = []
	const mgr = new FileLockManager(makeLogger(), (e) => events.push(e), {
		// short defaults keep acquire-retry tests under a second total
		lockTimeoutMs: 60_000,
		acquireTimeoutMs: 200,
		maxLocksPerAgent: 10,
		...overrides,
	})
	return { mgr, events }
}

describe('FileLockManager', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	describe('acquire (happy path)', () => {
		it('acquires an unheld lock immediately + emits lock_acquired', async () => {
			const { mgr, events } = makeManager()
			const before = Date.now()
			const result = await mgr.acquire('/tmp/a.txt', runId(1))
			expect(result.acquired).toBe(true)
			if (result.acquired) {
				expect(result.lock.owner).toBe(runId(1))
				expect(result.lock.filePath).toBe('/tmp/a.txt')
				expect(result.lock.lockId).toMatch(/^lock_[0-9a-f-]+$/)
				expect(result.lock.acquiredAt).toBeGreaterThanOrEqual(before)
				expect(result.lock.expiresAt).toBeGreaterThan(result.lock.acquiredAt)
			}
			const acquired = events.filter((e) => e.type === 'lock_acquired')
			expect(acquired).toHaveLength(1)
		})

		it('is idempotent for the same owner — returns the existing lock, emits nothing', async () => {
			const { mgr, events } = makeManager()
			const first = await mgr.acquire('/tmp/a.txt', runId(1))
			events.length = 0
			const second = await mgr.acquire('/tmp/a.txt', runId(1))
			expect(second.acquired).toBe(true)
			if (first.acquired && second.acquired) {
				expect(second.lock.lockId).toBe(first.lock.lockId)
			}
			expect(events).toEqual([])
		})
	})

	describe('acquire (contention)', () => {
		it('emits lock_denied when another owner holds the lock and no release happens', async () => {
			const { mgr, events } = makeManager({ acquireTimeoutMs: 120 })
			await mgr.acquire('/tmp/a.txt', runId(1))
			events.length = 0

			const result = await mgr.acquire('/tmp/a.txt', runId(2))
			expect(result.acquired).toBe(false)
			if (!result.acquired) {
				expect(result.holder).toBe(runId(1))
				expect(result.filePath).toBe('/tmp/a.txt')
			}
			expect(events.some((e) => e.type === 'lock_denied')).toBe(true)
		})

		it('succeeds on a retry once the holder releases before the deadline', async () => {
			const { mgr } = makeManager({ acquireTimeoutMs: 500 })
			await mgr.acquire('/tmp/a.txt', runId(1))

			const contender = mgr.acquire('/tmp/a.txt', runId(2))
			setTimeout(() => mgr.release('/tmp/a.txt', runId(1)), 120)

			const result = await contender
			expect(result.acquired).toBe(true)
			if (result.acquired) expect(result.lock.owner).toBe(runId(2))
		})
	})

	describe('maxLocksPerAgent cap', () => {
		it('denies a new acquisition when the owner is at cap — acquire polls to deadline then returns empty holder', async () => {
			const { mgr } = makeManager({ maxLocksPerAgent: 2, acquireTimeoutMs: 60 })
			await mgr.acquire('/tmp/a.txt', runId(1))
			await mgr.acquire('/tmp/b.txt', runId(1))

			const over = await mgr.acquire('/tmp/c.txt', runId(1))
			expect(over.acquired).toBe(false)
			if (!over.acquired) {
				// No lock exists on /tmp/c.txt, so the fallback holder is ''.
				expect(over.holder).toBe('' as RunId)
				expect(over.filePath).toBe('/tmp/c.txt')
			}
		})
	})

	describe('release', () => {
		it('releases an owned lock + emits lock_released', async () => {
			const { mgr, events } = makeManager()
			await mgr.acquire('/tmp/a.txt', runId(1))
			events.length = 0

			expect(mgr.release('/tmp/a.txt', runId(1))).toBe(true)
			expect(mgr.isLocked('/tmp/a.txt')).toBe(false)
			expect(events.some((e) => e.type === 'lock_released')).toBe(true)
		})

		it('returns false + emits nothing when the caller is not the holder', async () => {
			const { mgr, events } = makeManager()
			await mgr.acquire('/tmp/a.txt', runId(1))
			events.length = 0

			expect(mgr.release('/tmp/a.txt', runId(2))).toBe(false)
			expect(mgr.isLocked('/tmp/a.txt')).toBe(true)
			expect(events).toEqual([])
		})

		it('returns false when no lock exists', () => {
			const { mgr, events } = makeManager()
			expect(mgr.release('/tmp/never.txt', runId(1))).toBe(false)
			expect(events).toEqual([])
		})
	})

	describe('releaseAll', () => {
		it('drops every lock owned by the runId, emits one event per lock, returns count', async () => {
			const { mgr, events } = makeManager()
			await mgr.acquire('/tmp/a.txt', runId(1))
			await mgr.acquire('/tmp/b.txt', runId(1))
			await mgr.acquire('/tmp/c.txt', runId(2))
			events.length = 0

			const count = mgr.releaseAll(runId(1))
			expect(count).toBe(2)
			expect(mgr.isLocked('/tmp/a.txt')).toBe(false)
			expect(mgr.isLocked('/tmp/b.txt')).toBe(false)
			expect(mgr.isLocked('/tmp/c.txt')).toBe(true)
			expect(events.filter((e) => e.type === 'lock_released')).toHaveLength(2)
		})

		it('returns 0 when the owner has no locks', () => {
			const { mgr } = makeManager()
			expect(mgr.releaseAll(runId(99))).toBe(0)
		})
	})

	describe('expiry', () => {
		it('expireStale drops expired locks + emits lock_expired per drop', async () => {
			vi.useFakeTimers()
			const { mgr, events } = makeManager({ lockTimeoutMs: 10_000 })
			await mgr.acquire('/tmp/a.txt', runId(1))
			await mgr.acquire('/tmp/b.txt', runId(2))
			events.length = 0

			vi.advanceTimersByTime(10_001)
			const expired = mgr.expireStale()
			expect(expired).toBe(2)
			expect(events.filter((e) => e.type === 'lock_expired')).toHaveLength(2)
		})

		it('isLocked / getHolder auto-expire a stale lock before answering', async () => {
			vi.useFakeTimers()
			const { mgr, events } = makeManager({ lockTimeoutMs: 5_000 })
			await mgr.acquire('/tmp/a.txt', runId(1))

			vi.advanceTimersByTime(5_001)
			events.length = 0
			expect(mgr.isLocked('/tmp/a.txt')).toBe(false)
			expect(events.some((e) => e.type === 'lock_expired')).toBe(true)

			events.length = 0
			expect(mgr.getHolder('/tmp/a.txt')).toBeUndefined()
			// already expired by the previous call; no second emit
			expect(events).toEqual([])
		})

		it('a fresh acquire after expiry assigns a new lockId', async () => {
			vi.useFakeTimers()
			const { mgr } = makeManager({ lockTimeoutMs: 1_000 })
			const first = await mgr.acquire('/tmp/a.txt', runId(1))
			vi.advanceTimersByTime(1_001)
			mgr.expireStale()

			vi.useRealTimers()
			const second = await mgr.acquire('/tmp/a.txt', runId(2))
			expect(first.acquired && second.acquired).toBe(true)
			if (first.acquired && second.acquired) {
				expect(second.lock.lockId).not.toBe(first.lock.lockId)
				expect(second.lock.owner).toBe(runId(2))
			}
		})
	})

	describe('per-runId isolation', () => {
		it('different runIds can hold locks on different files concurrently', async () => {
			const { mgr } = makeManager()
			const a = await mgr.acquire('/tmp/a.txt', runId(1))
			const b = await mgr.acquire('/tmp/b.txt', runId(2))
			expect(a.acquired && b.acquired).toBe(true)
			expect(mgr.getHolder('/tmp/a.txt')).toBe(runId(1))
			expect(mgr.getHolder('/tmp/b.txt')).toBe(runId(2))
		})
	})
})
