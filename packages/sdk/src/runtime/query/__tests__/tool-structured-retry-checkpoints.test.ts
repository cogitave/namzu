import { describe, expect, it } from 'vitest'
import { CheckpointDocumentError, parseCheckpoint } from '../../../types/session/checkpoint.js'
import { CheckpointManager } from '../checkpoint.js'
import {
	type CheckpointedSession,
	checkpointRecords,
	sessionWithCheckpoint,
} from './support/session.js'

function manager(session: CheckpointedSession): CheckpointManager {
	return new CheckpointManager(checkpointRecords(session), session.store, session.scope)
}

/** The recorder projection read by the real manager; records and commits use the session lease. */
function recorder(session: CheckpointedSession): never {
	return {
		...checkpointRecords(session),
		tokenUsage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
		currentIteration: 2,
		getTurn: () => ({ startedAt: 1_000 }),
		head: () => session.log.head(),
		recordedIdOf: () => undefined,
	} as never
}

describe('tool structured correction checkpoint state', () => {
	it('restores legacy v1 checkpoints as zero without adding a field to their document', async () => {
		const session = await sessionWithCheckpoint({
			document: {
				review: { answerAttempts: 1, structuredAttempts: 2, nativeStructuredAttempts: 3 },
			},
		})
		const mgr = manager(session)
		const restored = await mgr.restore(session.checkpointId)

		expect(restored.document.review).not.toHaveProperty('toolStructuredAttempts')
		expect(mgr.restoredToolStructuredAttempts).toBe(0)
		expect(mgr.restoredAnswerReviewAttempts).toBe(1)
		expect(mgr.restoredStructuredReviewAttempts).toBe(2)
		expect(mgr.restoredNativeStructuredAttempts).toBe(3)
		const next = await mgr.create(recorder(session), 3)
		expect(next.document.review).toEqual({
			answerAttempts: 1,
			structuredAttempts: 2,
			nativeStructuredAttempts: 3,
			toolStructuredAttempts: 0,
		})
	})

	it('keeps all four counters independent across save, restore and the next checkpoint', async () => {
		const session = await sessionWithCheckpoint()
		const mgr = manager(session)
		mgr.setAnswerReviewAttemptsSource(() => 1)
		mgr.setStructuredReviewAttemptsSource(() => 2)
		mgr.setNativeStructuredAttemptsSource(() => 3)
		let toolAttempts = 4
		mgr.setToolStructuredAttemptsSource(() => toolAttempts)
		const first = await mgr.create(recorder(session), 3)
		toolAttempts = 5
		const second = await mgr.create(recorder(session), 4)

		const resumed = manager(session)
		await resumed.restore(second.id)
		expect(resumed.restoredToolStructuredAttempts).toBe(5)
		await resumed.restore(first.id)
		expect(resumed.restoredToolStructuredAttempts).toBe(4)
		expect(resumed.restoredAnswerReviewAttempts).toBe(1)
		expect(resumed.restoredStructuredReviewAttempts).toBe(2)
		expect(resumed.restoredNativeStructuredAttempts).toBe(3)
		// A caller selecting the older checkpoint gets that checkpoint's
		// allowance, even when a newer one consumed another correction.
		const next = await resumed.create(recorder(session), 4)
		expect(next.document.review).toEqual({
			answerAttempts: 1,
			structuredAttempts: 2,
			nativeStructuredAttempts: 3,
			toolStructuredAttempts: 4,
		})
	})

	it('captures the loop-start count instead of a later live source value', async () => {
		const session = await sessionWithCheckpoint()
		const mgr = manager(session)
		let toolAttempts = 1
		mgr.setToolStructuredAttemptsSource(() => toolAttempts)
		await mgr.markLoopStart(recorder(session))
		toolAttempts = 3
		const checkpoint = await mgr.createAtLoopStart(recorder(session))

		expect(checkpoint?.document.review.toolStructuredAttempts).toBe(1)
		const resumed = manager(session)
		if (!checkpoint) throw new Error('Expected the recorded loop-start checkpoint')
		await resumed.restore(checkpoint.id)
		expect(resumed.restoredToolStructuredAttempts).toBe(1)
	})

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, null, '1'])(
		'refuses an invalid tool correction counter %s rather than giving it a zero allowance',
		async (toolStructuredAttempts) => {
			const session = await sessionWithCheckpoint()
			const document = await session.store.read(session.scope, session.checkpointId)
			if (!document) throw new Error('Expected the initial committed checkpoint')
			expect(() =>
				parseCheckpoint({
					...document,
					review: { ...document.review, toolStructuredAttempts },
				}),
			).toThrow(CheckpointDocumentError)
		},
	)
})
