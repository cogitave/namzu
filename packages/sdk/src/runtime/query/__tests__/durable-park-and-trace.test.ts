import { beforeEach, describe, expect, it } from 'vitest'

import { serializeSpan } from '../../../telemetry/attributes.js'
import type { HITLDecisionRequest, PendingDecision } from '../../../types/hitl/index.js'
import type { CheckpointId } from '../../../types/ids/index.js'
import { deriveTurnStatus } from '../../../types/session/derive-status.js'
import {
	CheckpointManager,
	findPendingCheckpoint,
	isExpiredPark,
	listExpiredParks,
	readParks,
} from '../checkpoint.js'
import {
	type CheckpointedSession,
	checkpointRecords,
	sessionWithCheckpoint,
} from './support/session.js'

/**
 * Two durability holes that only show up across a process boundary.
 *
 * A park had no deadline. Every timer in the SDK is an in-process
 * `setTimeout` and the park-record delay is deliberately `unref`'d, so
 * nothing in memory can outlive a redeploy: a run parks for approval, the
 * worker is replaced, nobody answers, and the checkpoint stays outstanding
 * forever — every approval-queue reader keeps serving it. The run timeout
 * cannot cover it either, because it is only checked between iterations
 * and a park suspends mid-iteration.
 *
 * And a checkpoint recorded no trace, so a run that crashed at iteration
 * 12 and resumed produced two traces with different ids and no link. The
 * run id correlates them well enough to find both by query and not well
 * enough to see one waterfall — and for a fork, which starts a new
 * session, not even that.
 */

const request = (session: CheckpointedSession): HITLDecisionRequest =>
	({
		type: 'tool_review',
		sessionId: session.sessionId,
		turnId: session.turnId,
		checkpointId: session.checkpointId,
		toolCalls: [{ id: 't1', name: 'deploy', input: {}, isDestructive: true }],
	}) as HITLDecisionRequest

/** The recorder side `create` reads: the turn's usage and the log's head. */
function recorder(session: CheckpointedSession): never {
	return {
		...checkpointRecords(session),
		messages: [],
		currentIteration: 3,
		tokenUsage: {
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { totalCost: 0.01, cacheDiscount: 0, unpricedTokens: 0 },
		getTurn: () => ({ startedAt: Date.now() - 1_000 }),
		head: () => session.log.head(),
		recordedIdOf: () => undefined,
	} as never
}

describe('a park that nobody answers', () => {
	let session: CheckpointedSession
	let manager: CheckpointManager

	beforeEach(async () => {
		session = await sessionWithCheckpoint()
		manager = new CheckpointManager(checkpointRecords(session), session.store, session.scope)
	})

	const park = async (ttlMs?: number): Promise<{ id: CheckpointId; pending: PendingDecision }> => {
		const checkpoint = await manager.create(recorder(session), 1)
		const pending = await manager.park(
			checkpoint,
			request(session),
			ttlMs === undefined ? undefined : { ttlMs },
		)
		return { id: checkpoint.id, pending }
	}

	it('records an ABSOLUTE deadline, so it survives the process that set it', async () => {
		const parked = await park(60_000)
		// A duration plus an in-process timer cannot survive a redeploy,
		// which is the whole failure being fixed.
		expect(parked.pending.deadlineAt).toBeGreaterThan(Date.now())
		expect(parked.pending.deadlineAt).toBe(parked.pending.parkedAt + 60_000)
	})

	it('stops being served once the deadline passes', async () => {
		await park(1)
		await new Promise((resolve) => setTimeout(resolve, 5))

		// Serving it re-presents an approval whose window has closed, and
		// every queue reader would keep re-presenting it forever.
		expect(await findPendingCheckpoint(session.log, { turnId: session.turnId })).toBeNull()
	})

	it('is still served before the deadline', async () => {
		const parked = await park(60_000)
		expect(
			(await findPendingCheckpoint(session.log, { turnId: session.turnId }))?.checkpointId,
		).toBe(parked.id)
	})

	it('never expires when no deadline was set', async () => {
		// The default has to stay today's behaviour: a host that never asked
		// for a TTL must not start losing approvals.
		const parked = await park(undefined)
		expect(parked.pending.deadlineAt).toBeUndefined()
		expect(
			(
				await findPendingCheckpoint(session.log, {
					turnId: session.turnId,
					now: Date.now() + 10 ** 9,
				})
			)?.checkpointId,
		).toBe(parked.id)
	})

	it('is enumerable so a host can sweep it', async () => {
		await park(1)
		await new Promise((resolve) => setTimeout(resolve, 5))

		// The out-of-process timer stays a host concern, but a host cannot
		// sweep what it cannot enumerate.
		expect(await listExpiredParks(session.log)).toHaveLength(1)
	})

	it('records the expiry rather than deleting the evidence', async () => {
		const parked = await park(1)
		await new Promise((resolve) => setTimeout(resolve, 5))

		expect(await manager.expire(parked.id)).not.toBeNull()
		const [expired] = await readParks(session.log, { turnId: session.turnId })
		expect(expired?.pending.resolvedAt).toBeGreaterThan(0)
		// A log showing what was asked and that nobody answered is the
		// evidence an approval gate is worth having.
		expect(expired?.pending.request).toEqual(parked.pending.request)
		expect(expired?.pending.decision).toMatchObject({ action: 'pause' })
	})

	it('does not re-expire a park that was already answered', async () => {
		const parked = await park(1)
		await manager.unpark(parked.id, { action: 'approve_tools' })
		expect(await manager.expire(parked.id)).toBeNull()
	})

	it('applies the manager default when no per-park ttl is given', async () => {
		manager.setParkTtl(30_000)
		const parked = await park(undefined)
		expect(parked.pending.deadlineAt).toBe(parked.pending.parkedAt + 30_000)
	})
})

const plainRequest = {
	type: 'tool_review',
	turnId: '37ddff8e-e13f-4e57-937f-d048fa323f5e',
	checkpointId: 'f496fad2-a721-4bb9-9a40-b959b0f3ecf8',
	toolCalls: [{ id: 't1', name: 'deploy', input: {}, isDestructive: true }],
} as unknown as HITLDecisionRequest
const request0 = () => plainRequest

describe('deciding whether a park has expired', () => {
	it('is false without a deadline, at any time', () => {
		expect(isExpiredPark({ request: request0(), parkedAt: 0 }, 10 ** 12)).toBe(false)
	})

	it('is true at the deadline, not only past it', () => {
		expect(isExpiredPark({ request: request0(), parkedAt: 0, deadlineAt: 100 }, 100)).toBe(true)
	})
})

describe('projecting a run onto the session-layer status', () => {
	const park = { request: request0(), parkedAt: 0, deadlineAt: 100 }

	it('produces the variant that never had a producer', () => {
		// `awaiting_hitl_resolution` has documented a "persisted wait after
		// a HITL timeout" since it was declared, for a timeout nothing could
		// raise.
		expect(deriveTurnStatus({ status: 'running', park, now: 200 })).toBe('awaiting_hitl_resolution')
	})

	it('reports a live park as awaiting, not expired', () => {
		expect(deriveTurnStatus({ status: 'running', park, now: 50 })).toBe('awaiting_hitl')
	})

	it('lets a terminal run beat a stale park record', () => {
		// A run that finished is not waiting for anyone, whatever the park
		// record still says.
		expect(deriveTurnStatus({ status: 'completed', park, now: 200 })).toBe('succeeded')
		expect(deriveTurnStatus({ status: 'failed', park, now: 200 })).toBe('failed')
	})

	it('ignores a park that was already answered', () => {
		expect(
			deriveTurnStatus({ status: 'running', park: { ...park, resolvedAt: 60 }, now: 200 }),
		).toBe('running')
	})

	it('maps an unparked run without inventing a wait', () => {
		expect(deriveTurnStatus({ status: 'running' })).toBe('running')
		expect(deriveTurnStatus({ status: 'idle' })).toBe('queued')
		expect(deriveTurnStatus({ status: 'cancelled' })).toBe('cancelled')
	})
})

describe('the trace a checkpoint was taken inside', () => {
	let session: CheckpointedSession
	let manager: CheckpointManager

	beforeEach(async () => {
		session = await sessionWithCheckpoint()
		manager = new CheckpointManager(checkpointRecords(session), session.store, session.scope)
	})

	const fakeSpan = (traceId: string, spanId: string) =>
		({ spanContext: () => ({ traceId, spanId, traceFlags: 1 }) }) as never

	it('is recorded, so a resume can join it', async () => {
		manager.setTraceSource(() => serializeSpan(fakeSpan('a'.repeat(32), 'b'.repeat(16))))
		const checkpoint = await manager.create(recorder(session), 1)

		expect(checkpoint.document.trace).toMatchObject({
			traceId: 'a'.repeat(32),
			spanId: 'b'.repeat(16),
		})
	})

	it('is readable back without loading the whole restore path', async () => {
		manager.setTraceSource(() => serializeSpan(fakeSpan('c'.repeat(32), 'd'.repeat(16))))
		const checkpoint = await manager.create(recorder(session), 1)

		// Read before the root span is minted, because a parent can only be
		// set at creation.
		expect((await manager.readTraceContext(checkpoint.id))?.traceId).toBe('c'.repeat(32))
	})

	it('never fails a resume over telemetry', async () => {
		// A missing checkpoint here must not throw: the restore path
		// immediately after reports it far better than a tracing helper can.
		expect(
			await manager.readTraceContext('e8e27c68-a53c-4003-9fbe-3349649af71a' as CheckpointId),
		).toBeUndefined()
	})

	it('refuses an all-zero trace id rather than emitting an orphan', async () => {
		// An exporter given a zero id drops the span silently, which turns
		// "linked to the crash" into "no resume trace at all" — worse than
		// the disconnected traces this replaces.
		expect(serializeSpan(fakeSpan('0'.repeat(32), 'e'.repeat(16)))).toBeUndefined()
	})

	it('is absent when no telemetry is registered', async () => {
		const checkpoint = await manager.create(recorder(session), 1)
		expect(checkpoint.document.trace).toBeUndefined()
	})
})
