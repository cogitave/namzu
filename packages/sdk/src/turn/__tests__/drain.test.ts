/**
 * `drainParkedTurns` — the loop every host had to write itself.
 *
 * These are the single-process properties: what it refuses, what it
 * releases, what it does with a lease it lost. The properties that need
 * REAL processes — exclusivity, fencing, a dead holder — are in
 * `drain-processes.proc-test.ts`, because a lease tested inside one process
 * is arbitrated by the event loop rather than by the store, which is the
 * mechanism under test.
 */

import { describe, expect, it, vi } from 'vitest'

import {
	type SessionLease,
	type SessionLog,
	StaleSessionLeaseError,
} from '../../store/session-log/index.js'
import type { DurableTurnEntry } from '../../types/session/durable.js'
import { drainParkedTurns } from '../drain.js'
import { queue } from './support/queue.js'

const holder = 'w_test'
const ttlMs = 60_000

describe('refusing configuration that cannot mean what it says', () => {
	it('refuses an empty holder', async () => {
		const q = await queue([{ parked: true }])
		const onTurn = vi.fn()
		await expect(
			drainParkedTurns({ ...q.base, holder: '  ', ttlMs, onTurn }),
		).rejects.toMatchObject({ code: 'invalid_config' })
		expect(onTurn).not.toHaveBeenCalled()
	})

	it('refuses a lease that has already expired', async () => {
		const q = await queue([{ parked: true }])
		const onTurn = vi.fn()
		await expect(drainParkedTurns({ ...q.base, holder, ttlMs: 0, onTurn })).rejects.toMatchObject({
			code: 'invalid_config',
		})
		expect(onTurn).not.toHaveBeenCalled()
	})

	it('refuses a concurrency of zero rather than reporting an empty pass', async () => {
		const q = await queue([{ parked: true }])
		const onTurn = vi.fn()
		await expect(
			drainParkedTurns({ ...q.base, holder, ttlMs, onTurn, maxConcurrent: 0 }),
		).rejects.toMatchObject({ code: 'invalid_config' })
		expect(onTurn).not.toHaveBeenCalled()
	})
})

describe('one pass over the queue', () => {
	it('takes every unclaimed turn and hands each one its own lease', async () => {
		const q = await queue([{ parked: true }, { parked: true }, { parked: true }])
		const seen: Array<{ entry: DurableTurnEntry; lease: SessionLease }> = []

		const result = await drainParkedTurns({
			...q.base,
			holder,
			ttlMs,
			onTurn: async (entry, lease) => {
				seen.push({ entry, lease })
			},
		})

		expect(result.listed).toBe(3)
		expect([...result.drained].sort()).toEqual(q.sessions.map((s) => s.turnId).sort())
		expect(seen.map((s) => s.entry.sessionId).sort()).toEqual(
			q.sessions.map((s) => s.sessionId).sort(),
		)
		expect(seen.every((s) => s.lease.holder === holder)).toBe(true)
		expect(result.failed).toEqual([])
		expect(result.stopped).toBe(false)
	})

	it('gives every turn back, so a second pass sees the same queue', async () => {
		const q = await queue([{ parked: true }, { parked: true }])
		const first = await drainParkedTurns({ ...q.base, holder, ttlMs, onTurn: async () => {} })
		const second = await drainParkedTurns({ ...q.base, holder, ttlMs, onTurn: async () => {} })
		expect(second.drained.length).toBe(first.drained.length)
		expect(second.skipped).toEqual([])
	})

	it('releases a turn whose work threw, and keeps going', async () => {
		const q = await queue([{ parked: true }, { parked: true }])
		let calls = 0
		const result = await drainParkedTurns({
			...q.base,
			holder,
			ttlMs,
			onTurn: async () => {
				calls++
				if (calls === 1) throw new Error('worker blew up')
			},
		})
		expect(result.failed).toHaveLength(1)
		expect(result.failed[0]?.error).toBe('worker blew up')
		expect(result.drained).toHaveLength(1)
		// Released: another worker can take every session straight away.
		for (const session of q.sessions) {
			expect(await session.log.claim({ holder: 'w_next', ttlMs })).not.toBeNull()
		}
	})

	it('never offers a turn another worker currently holds', async () => {
		const q = await queue([{ parked: true, held: true }, { parked: true }])
		const onTurn = vi.fn(async () => {})
		const result = await drainParkedTurns({ ...q.base, holder, ttlMs, onTurn })
		const held = q.sessions[0]!
		expect(result.skipped).toEqual([held.turnId])
		expect(onTurn).toHaveBeenCalledTimes(1)
		expect(result.drained).toEqual([q.sessions[1]!.turnId])
	})

	it('offers a turn whose holder has expired, because that is what expiry means', async () => {
		const q = await queue([{ parked: true, held: true }])
		const onTurn = vi.fn(async () => {})
		const result = await drainParkedTurns({
			...q.base,
			holder,
			ttlMs,
			onTurn,
			// Judged past the holder's lease.
			now: Date.now() + 10 * ttlMs,
		})
		expect(result.drained).toEqual([q.sessions[0]!.turnId])
		expect(onTurn).toHaveBeenCalledTimes(1)
	})

	it('gives back a turn that stopped matching between the listing and the claim', async () => {
		// Somebody answered the park after the listing was taken: the listing
		// still names it, the log under the lease does not.
		const q = await queue([{ answered: true }])
		const session = q.sessions[0]!
		const staleListing = [
			{
				decisionId: session.checkpointId,
				sessionId: session.sessionId,
				turnId: session.turnId,
				checkpointId: session.checkpointId,
			},
		]
		const index = { ...q.index, listPendingDecisions: async () => staleListing }
		const onTurn = vi.fn(async () => {})

		const result = await drainParkedTurns({
			...q.base,
			index: index as typeof q.index,
			holder,
			ttlMs,
			onTurn,
			park: ['outstanding'],
		})

		expect(result.stale).toEqual([session.turnId])
		expect(onTurn).not.toHaveBeenCalled()
	})

	it('passes the park filter through instead of inventing one', async () => {
		const q = await queue([{ parked: true }, {}])
		const inbox = await drainParkedTurns({
			...q.base,
			holder,
			ttlMs,
			onTurn: async () => {},
			park: ['outstanding'],
		})
		expect(inbox.drained).toEqual([q.sessions[0]!.turnId])
		// No filter: every open turn nobody holds, parked or not — a crash sweep.
		const sweep = await drainParkedTurns({ ...q.base, holder, ttlMs, onTurn: async () => {} })
		expect([...sweep.drained].sort()).toEqual(q.sessions.map((s) => s.turnId).sort())
	})
})

describe('bounds', () => {
	it('handles no more candidates than one page', async () => {
		const q = await queue([{ parked: true }, { parked: true }, { parked: true }])
		const result = await drainParkedTurns({
			...q.base,
			holder,
			ttlMs,
			onTurn: async () => {},
			pageSize: 2,
		})
		expect(result.listed).toBe(2)
		expect(result.drained).toHaveLength(2)
	})

	it('holds no more leases at once than it was allowed', async () => {
		const q = await queue([{ parked: true }, { parked: true }, { parked: true }, { parked: true }])
		let inFlight = 0
		let peak = 0
		await drainParkedTurns({
			...q.base,
			holder,
			ttlMs,
			maxConcurrent: 2,
			onTurn: async () => {
				inFlight++
				peak = Math.max(peak, inFlight)
				await new Promise<void>((resolve) => setImmediate(resolve))
				inFlight--
			},
		})
		expect(peak).toBe(2)
	})

	it('defaults to one turn at a time', async () => {
		const q = await queue([{ parked: true }, { parked: true }, { parked: true }])
		let inFlight = 0
		let peak = 0
		await drainParkedTurns({
			...q.base,
			holder,
			ttlMs,
			onTurn: async () => {
				inFlight++
				peak = Math.max(peak, inFlight)
				await new Promise<void>((resolve) => setImmediate(resolve))
				inFlight--
			},
		})
		expect(peak).toBe(1)
	})
})

describe('cancellation', () => {
	it('stops taking new turns once the signal aborts, and says it stopped', async () => {
		const q = await queue([{ parked: true }, { parked: true }, { parked: true }])
		const controller = new AbortController()
		const result = await drainParkedTurns({
			...q.base,
			holder,
			ttlMs,
			signal: controller.signal,
			onTurn: async () => {
				controller.abort()
			},
		})
		expect(result.drained).toHaveLength(1)
		expect(result.stopped).toBe(true)
	})

	it('claims nothing at all when the signal is already aborted', async () => {
		const q = await queue([{ parked: true }, { parked: true }])
		const onTurn = vi.fn(async () => {})
		const result = await drainParkedTurns({
			...q.base,
			holder,
			ttlMs,
			signal: AbortSignal.abort(),
			onTurn,
		})
		expect(onTurn).not.toHaveBeenCalled()
		expect(result.drained).toEqual([])
		expect(result.stopped).toBe(true)
	})
})

describe('what the callback receives', () => {
	it('hands over an entry that addresses the turn and its newest checkpoint and park', async () => {
		const q = await queue([{ parked: true }])
		const session = q.sessions[0]!
		let received: DurableTurnEntry | undefined
		await drainParkedTurns({
			...q.base,
			holder,
			ttlMs,
			onTurn: async (entry) => {
				received = entry
			},
		})
		expect(received).toMatchObject({
			tenantId: q.base.tenantId,
			sessionId: session.sessionId,
			turnId: session.turnId,
			latestCheckpointId: session.checkpointId,
			checkpointCount: 1,
			park: {
				state: 'outstanding',
				checkpointId: session.checkpointId,
				requestType: 'tool_review',
			},
		})
	})

	it('hands over a lease the log accepts, and a stale one it will not', async () => {
		const q = await queue([{ parked: true }])
		const session = q.sessions[0]!
		let held: SessionLease | undefined
		await drainParkedTurns({
			...q.base,
			holder,
			ttlMs,
			onTurn: async (entry, lease) => {
				held = lease
				// The whole reason the lease is handed over: this write is fenced.
				await session.log.append(lease, {
					type: 'iteration_started',
					turnId: entry.turnId,
					iteration: 2,
				} as Parameters<SessionLog['append']>[1])
			},
		})
		if (!held) throw new Error('onTurn never ran')

		// A later holding supersedes the first, and the first holder's write is
		// refused: a stalled worker cannot write over whoever took the turn.
		const next = (await session.log.claim({ holder: 'w_two', ttlMs })) as SessionLease
		expect(next.fence).toBeGreaterThan(held.fence)
		await expect(
			session.log.append(held, {
				type: 'iteration_started',
				turnId: session.turnId,
				iteration: 3,
			} as Parameters<SessionLog['append']>[1]),
		).rejects.toBeInstanceOf(StaleSessionLeaseError)
	})
})
