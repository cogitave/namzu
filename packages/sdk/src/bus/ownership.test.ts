/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 1):
 *
 *   - `claim(path, owner)` on an unowned file creates ownership, emits
 *     `ownership_claimed`, returns `{claimed: true, ownership}`.
 *   - `claim(path, owner)` by the same owner is idempotent — returns
 *     `{claimed: true, ownership}` WITHOUT re-emitting.
 *   - `claim(path, owner)` by a different owner is denied — emits
 *     `ownership_denied`, returns `{claimed: false, currentOwner, filePath}`.
 *   - `release(path, owner)` on the current owner deletes + emits; returns
 *     true. On mismatch or missing entry: returns false; no emit.
 *   - `transfer(path, from, to)` requires the current owner to equal
 *     `from`. Success replaces the entry with a new `claimedAt`, emits
 *     `ownership_transferred`; no intervening `ownership_released` or
 *     `ownership_claimed` events. Failure returns false; no emit.
 *   - `releaseAll(owner)` sweeps every ownership for `owner`, emits
 *     `ownership_released` per entry, returns the count. Other owners'
 *     entries are untouched.
 *   - File paths are normalised via `path.resolve` before keying —
 *     `./foo/bar` and the absolute resolution of the same path collide
 *     into one ownership slot.
 *   - Ownership is not per-tenant; only per-`RunId`. There is no tenant
 *     isolation at this layer (design.md §2.1 aspirational; see §2.7).
 */

import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentBusEvent } from '../types/bus/index.js'
import type { RunId } from '../types/ids/index.js'
import type { Logger } from '../utils/logger.js'

import { EditOwnershipTracker } from './ownership.js'

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function runId(n: number): RunId {
	return `run_${n}` as RunId
}

describe('EditOwnershipTracker', () => {
	let events: AgentBusEvent[]
	let tracker: EditOwnershipTracker

	beforeEach(() => {
		events = []
		tracker = new EditOwnershipTracker(makeLogger(), (e) => events.push(e))
	})

	describe('claim', () => {
		it('claims an unowned file, emits ownership_claimed, returns ownership', () => {
			const before = Date.now()
			const result = tracker.claim('/tmp/file.txt', runId(1))
			const after = Date.now()

			expect(result.claimed).toBe(true)
			if (result.claimed) {
				expect(result.ownership.owner).toBe(runId(1))
				expect(result.ownership.filePath).toBe(path.resolve('/tmp/file.txt'))
				expect(result.ownership.claimedAt).toBeGreaterThanOrEqual(before)
				expect(result.ownership.claimedAt).toBeLessThanOrEqual(after)
			}
			expect(events).toEqual([
				{ type: 'ownership_claimed', filePath: path.resolve('/tmp/file.txt'), owner: runId(1) },
			])
		})

		it('is idempotent when the same owner re-claims — no re-emit', () => {
			tracker.claim('/tmp/file.txt', runId(1))
			events.length = 0

			const result = tracker.claim('/tmp/file.txt', runId(1))
			expect(result.claimed).toBe(true)
			expect(events).toEqual([])
		})

		it('denies a claim by a different owner, emits ownership_denied', () => {
			tracker.claim('/tmp/file.txt', runId(1))
			events.length = 0

			const result = tracker.claim('/tmp/file.txt', runId(2))
			expect(result.claimed).toBe(false)
			if (!result.claimed) {
				expect(result.currentOwner).toBe(runId(1))
				expect(result.filePath).toBe(path.resolve('/tmp/file.txt'))
			}
			expect(events).toEqual([
				{
					type: 'ownership_denied',
					filePath: path.resolve('/tmp/file.txt'),
					requester: runId(2),
					currentOwner: runId(1),
				},
			])
		})

		it('normalises file paths — equivalent paths collide', () => {
			tracker.claim('/tmp/foo/../file.txt', runId(1))
			const result = tracker.claim('/tmp/file.txt', runId(2))
			expect(result.claimed).toBe(false)
		})
	})

	describe('release', () => {
		it('releases an owned file, emits ownership_released, returns true', () => {
			tracker.claim('/tmp/file.txt', runId(1))
			events.length = 0

			const ok = tracker.release('/tmp/file.txt', runId(1))
			expect(ok).toBe(true)
			expect(tracker.getOwner('/tmp/file.txt')).toBeUndefined()
			expect(events).toEqual([
				{
					type: 'ownership_released',
					filePath: path.resolve('/tmp/file.txt'),
					previousOwner: runId(1),
				},
			])
		})

		it('returns false when no ownership exists — no emit', () => {
			const ok = tracker.release('/tmp/never-claimed.txt', runId(1))
			expect(ok).toBe(false)
			expect(events).toEqual([])
		})

		it('returns false when owner mismatches — no emit', () => {
			tracker.claim('/tmp/file.txt', runId(1))
			events.length = 0

			const ok = tracker.release('/tmp/file.txt', runId(2))
			expect(ok).toBe(false)
			expect(tracker.getOwner('/tmp/file.txt')).toBe(runId(1))
			expect(events).toEqual([])
		})
	})

	describe('transfer', () => {
		it('transfers ownership from current owner to another — atomic, single event', () => {
			tracker.claim('/tmp/file.txt', runId(1))
			events.length = 0

			const ok = tracker.transfer('/tmp/file.txt', runId(1), runId(2))
			expect(ok).toBe(true)
			expect(tracker.getOwner('/tmp/file.txt')).toBe(runId(2))
			expect(events).toEqual([
				{
					type: 'ownership_transferred',
					filePath: path.resolve('/tmp/file.txt'),
					from: runId(1),
					to: runId(2),
				},
			])
		})

		it('returns false when the `from` argument is not the current owner — no emit', () => {
			tracker.claim('/tmp/file.txt', runId(1))
			events.length = 0

			const ok = tracker.transfer('/tmp/file.txt', runId(99), runId(2))
			expect(ok).toBe(false)
			expect(tracker.getOwner('/tmp/file.txt')).toBe(runId(1))
			expect(events).toEqual([])
		})

		it('returns false when no ownership exists — no emit', () => {
			const ok = tracker.transfer('/tmp/file.txt', runId(1), runId(2))
			expect(ok).toBe(false)
			expect(events).toEqual([])
		})

		it('refreshes claimedAt on successful transfer', async () => {
			tracker.claim('/tmp/file.txt', runId(1))
			const t0 = tracker.getOwner('/tmp/file.txt')
			expect(t0).toBe(runId(1))

			await new Promise((r) => setTimeout(r, 2))
			tracker.transfer('/tmp/file.txt', runId(1), runId(2))
			const list = tracker.listByOwner(runId(2))
			expect(list).toHaveLength(1)
			const after = list[0]
			expect(after?.claimedAt).toBeGreaterThan(0)
			expect(after?.owner).toBe(runId(2))
		})
	})

	describe('releaseAll', () => {
		it('releases every ownership for the owner, returns count, emits per-entry', () => {
			tracker.claim('/tmp/a.txt', runId(1))
			tracker.claim('/tmp/b.txt', runId(1))
			tracker.claim('/tmp/c.txt', runId(2))
			events.length = 0

			const count = tracker.releaseAll(runId(1))
			expect(count).toBe(2)
			expect(tracker.getOwner('/tmp/a.txt')).toBeUndefined()
			expect(tracker.getOwner('/tmp/b.txt')).toBeUndefined()
			expect(tracker.getOwner('/tmp/c.txt')).toBe(runId(2))

			const released = events.filter((e) => e.type === 'ownership_released')
			expect(released.length).toBe(2)
			for (const e of released) {
				if (e.type === 'ownership_released') {
					expect(e.previousOwner).toBe(runId(1))
				}
			}
		})

		it('returns 0 when the owner has no entries', () => {
			const count = tracker.releaseAll(runId(99))
			expect(count).toBe(0)
			expect(events).toEqual([])
		})
	})

	describe('read helpers', () => {
		it('getOwner returns undefined for unclaimed paths', () => {
			expect(tracker.getOwner('/tmp/anything.txt')).toBeUndefined()
		})

		it('listByOwner returns all ownerships for a given owner', () => {
			tracker.claim('/tmp/a.txt', runId(1))
			tracker.claim('/tmp/b.txt', runId(1))
			tracker.claim('/tmp/c.txt', runId(2))

			const list = tracker.listByOwner(runId(1))
			expect(list.length).toBe(2)
			expect(new Set(list.map((o) => o.filePath))).toEqual(
				new Set([path.resolve('/tmp/a.txt'), path.resolve('/tmp/b.txt')]),
			)
		})

		it('checkConflict returns the current owner iff a different owner holds the file', () => {
			tracker.claim('/tmp/file.txt', runId(1))
			expect(tracker.checkConflict('/tmp/file.txt', runId(1))).toBeUndefined()
			expect(tracker.checkConflict('/tmp/file.txt', runId(2))).toBe(runId(1))
			expect(tracker.checkConflict('/tmp/other.txt', runId(2))).toBeUndefined()
		})
	})
})
