/**
 * One drain pass against a real session log: the turn a crashed process left
 * parked, the lease it left behind, and the lease somebody still holds.
 *
 * `drain.test.ts` proves the command wires the pieces together; this proves
 * the pass does the right thing with what a log actually says.
 */

import {
	InMemorySessionLog,
	type SessionLease,
	type SessionRecordDraft,
	type TurnId,
	generateCheckpointId,
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { type DrainPassDeps, drainSessionPass } from '../drain.js'

const T0 = Date.now()

/** A session whose one turn was parked by a worker that then went away. */
async function parkedByAnotherProcess(options: { leaseTtlMs: number }) {
	const log = new InMemorySessionLog({ sessionId: generateSessionId() })
	const worker = await log.claim({ holder: 'crashed-worker', ttlMs: options.leaseTtlMs, now: T0 })
	if (!worker) throw new Error('claim failed')
	await log.append(worker, {
		type: 'session_started',
		projectId: generateProjectId(),
		cwd: '/w',
		agent: { id: 'a', name: 'A' },
	} as SessionRecordDraft)
	const turnId = generateTurnId()
	await log.beginTurn(worker, {
		turnId,
		userMessageId: generateMessageId(),
		config: { model: 'm', tokenBudget: 0, maxIterations: 0, timeoutMs: 0 },
	})
	await log.append(worker, {
		type: 'turn_paused',
		turnId,
		reason: 'provider unavailable',
		checkpointId: generateCheckpointId(),
	} as SessionRecordDraft)
	return { log, worker, turnId }
}

function deps(
	log: InMemorySessionLog,
	overrides: Partial<DrainPassDeps> = {},
): DrainPassDeps & { resumed: { turnId: TurnId; lease: SessionLease }[] } {
	const resumed: { turnId: TurnId; lease: SessionLease }[] = []
	return {
		log,
		pendingDecisionTurns: new Set(),
		claim: () => log.claim({ holder: 'drainer', ttlMs: 60_000 }),
		release: (lease) => log.release(lease),
		resume: async (turnId, lease) => {
			resumed.push({ turnId, lease })
			return { resumed: true, turn: { status: 'completed' }, state: {} } as never
		},
		info: () => {},
		resumed,
		...overrides,
	}
}

describe('a drain pass over a real session log', () => {
	it('continues a turn another process parked, under a fence above that process', async () => {
		const { log, worker, turnId } = await parkedByAnotherProcess({ leaseTtlMs: 1 })
		const d = deps(log)
		const result = await drainSessionPass(d)
		expect(result).toMatchObject({ listed: 1, resumed: [turnId], heldByOthers: [], failed: [] })
		expect(d.resumed).toHaveLength(1)
		expect(d.resumed[0]?.turnId).toBe(turnId)
		// A stalled crashed-worker's next append is refused because of this.
		expect(d.resumed[0]?.lease.fence).toBeGreaterThan(worker.fence)
		// Given back: the next reader can take the session at once.
		expect(await log.claim({ holder: 'next', ttlMs: 1000 })).not.toBeNull()
	})

	it('skips a session whose lease another process still holds', async () => {
		const { log, turnId } = await parkedByAnotherProcess({ leaseTtlMs: 3_600_000 })
		const d = deps(log)
		const result = await drainSessionPass(d)
		expect(result).toMatchObject({ listed: 1, heldByOthers: [turnId], resumed: [] })
		expect(d.resumed).toEqual([])
	})

	it('reports a turn with an open decision and never takes the session', async () => {
		const { log, turnId } = await parkedByAnotherProcess({ leaseTtlMs: 1 })
		const claim = vi.fn(() => log.claim({ holder: 'drainer', ttlMs: 60_000 }))
		const d = deps(log, { pendingDecisionTurns: new Set([turnId]), claim })
		const result = await drainSessionPass(d)
		expect(result).toMatchObject({ awaitingDecision: [turnId], resumed: [] })
		expect(claim).not.toHaveBeenCalled()
	})

	it('lists nothing for a session whose turn already settled', async () => {
		const { log, worker, turnId } = await parkedByAnotherProcess({ leaseTtlMs: 3_600_000 })
		await log.abandonTurn(worker, turnId, 'operator gave up')
		const result = await drainSessionPass(deps(log))
		expect(result).toMatchObject({ listed: 0, resumed: [] })
	})

	it('gives the lease back even when the resume fails, and names the turn', async () => {
		const { log, turnId } = await parkedByAnotherProcess({ leaseTtlMs: 1 })
		const d = deps(log, {
			resume: async () => {
				throw new Error('provider refused')
			},
		})
		const result = await drainSessionPass(d)
		expect(result.failed).toEqual([{ turnId, error: 'provider refused' }])
		expect(await log.claim({ holder: 'next', ttlMs: 1000 })).not.toBeNull()
	})
})
