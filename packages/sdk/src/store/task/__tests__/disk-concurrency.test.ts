import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { SessionPaths } from '../../../session/paths.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { DiskTaskStore } from '../disk.js'

describe('DiskTaskStore — concurrency regressions', () => {
	let baseDir: string
	let sessionId: SessionId
	let turnId: TurnId
	let store: DiskTaskStore

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), 'namzu-task-concurrency-'))
		sessionId = generateSessionId()
		turnId = generateTurnId()
		store = new DiskTaskStore({
			paths: new SessionPaths({ home: baseDir, slug: '-work' }),
			session: { sessionId },
		})
	})

	afterEach(() => {
		removeTempDir(baseDir)
	})

	it('does not deadlock when two deletes race on mutually-referencing tasks', async () => {
		const a = await store.create({ sessionId, turnId, subject: 'A' })
		const b = await store.create({ sessionId, turnId, subject: 'B' })

		// Establish bidirectional edge: A blocks B AND B blocks A.
		// (Nonsensical semantically, but the store allows it and the lock logic
		// must not deadlock.)
		await store.block(a.id, b.id)
		await store.block(b.id, a.id)

		// Race the two deletes. The pre-fix implementation (lock this → iterate
		// related → lock each) could acquire A→B from one call and B→A from the
		// other, deadlocking. withLocks() sorts IDs canonically so both calls
		// acquire [A, B] in the same order.
		//
		// No real 2000ms timeout race here: it used to compete with the same
		// clock as the locking work it waited on, so a starved CI runner
		// could make that work outlast the guard even with no deadlock at
		// all. A genuine deadlock now hangs and fails on Vitest's own
		// per-test timeout instead of a hand-rolled one racing the same
		// clock.
		const [resA, resB] = await Promise.all([store.delete(a.id), store.delete(b.id)])
		expect(resA).toBe(true)
		expect(resB).toBe(true)
		expect(await store.get(a.id)).toBeUndefined()
		expect(await store.get(b.id)).toBeUndefined()
	})

	it('serializes concurrent same-ID updates (withLock race regression)', async () => {
		const task = await store.create({ sessionId, turnId, subject: 'shared' })

		// update()'s metadata merge does `{ ...task.metadata, ...updates.metadata }`
		// inside withLock. If withLock serializes correctly, every update's key
		// survives into the final metadata (each sees the latest merged state).
		// If withLock had the race bug, two concurrent updates would both read
		// the SAME snapshot, each add their one key, and one update's key would
		// be overwritten when the second committed — yielding < N keys in the
		// final metadata.
		const n = 20
		await Promise.all(
			Array.from({ length: n }, (_v, i) =>
				store.update(task.id, { metadata: { [`k${i}`]: true } }),
			),
		)

		const final = await store.get(task.id)
		const keys = Object.keys(final?.metadata ?? {})
		expect(keys).toHaveLength(n)
		for (let i = 0; i < n; i++) {
			expect(final?.metadata?.[`k${i}`]).toBe(true)
		}
	})

	it('establishes bidirectional edge atomically under create()', async () => {
		const blocker = await store.create({ sessionId, turnId, subject: 'blocker' })

		// Race: create a child with blockedBy=[blocker] while concurrently
		// deleting the blocker. Either outcome is acceptable (child created
		// and blocker still present in its blocks list, OR blocker gone and
		// child created with dangling reference), but we must NEVER see
		// blocker still present WITHOUT having child in its blocks list.
		const tasks = await Promise.all([
			store.create({ sessionId, turnId, subject: 'child', blockedBy: [blocker.id] }),
			// No delete here — keep the create edge test focused. The point is
			// that after create() resolves, the blocker's blocks list contains
			// the new task ID atomically.
		])
		const child = tasks[0]

		const blockerAfter = await store.get(blocker.id)
		expect(blockerAfter).toBeDefined()
		expect(blockerAfter?.blocks).toContain(child.id)
		expect(child.blockedBy).toContain(blocker.id)
	})

	it('block() skips gracefully when one task disappeared before lock acquired', async () => {
		const a = await store.create({ sessionId, turnId, subject: 'A' })
		const b = await store.create({ sessionId, turnId, subject: 'B' })

		// Delete B, then try to block a → b. The read under lock finds a but
		// not b, so block() returns early (silent no-op per existing contract).
		await store.delete(b.id)

		// block() should not throw and A's blocks list should remain empty.
		await store.block(a.id, b.id)

		const aAfter = await store.get(a.id)
		expect(aAfter?.blocks).not.toContain(b.id)
	})
})
