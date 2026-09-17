import { describe, expect, it } from 'vitest'

import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import type { CheckpointId, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { CheckpointRunScope } from '../../../types/run/checkpoint-store.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { CheckpointManager } from '../checkpoint.js'

/**
 * A checkpoint is the one thing a resumed run is not allowed to be wrong
 * about. Restore validates what it reads and refuses the rest, and two of
 * those refusals had never been executed by a test:
 *
 *  - the per-mode attempt counters, only the answer-review one of which
 *    appears anywhere in the suite — and then only on the WRITE side. A
 *    restored `Infinity` would make the next comparison in the loop always
 *    true and the run silently stop retrying.
 *  - the operator intent's timestamp, which is the one field of
 *    `latestUserMessage` the existing validation fixture does not try.
 *
 * The refusal is the right shape for all of them: a value that cannot be
 * believed must stop the resume, not be coerced. Coercing `-1` to `0` would
 * hand a run a fresh retry allowance it had already spent.
 */

const SCOPE: CheckpointRunScope = {
	tenantId: '31bdf543-d0dc-4022-b64a-09f4d6e8b377' as TenantId,
	projectId: 'e8110271-6961-4eb4-ac8c-7f55ea83839a' as ProjectId,
	sessionId: 'a89fa2a8-3672-4495-9a89-ad85ddaf0b50' as SessionId,
	runId: fixtureId.run('checkpoint-validation'),
	topicId: '3cd0ae75-30ea-4858-ae2c-ca6aed6ebe25' as TopicId,
} as CheckpointRunScope

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

const ZERO_COST = {
	inputCostPer1M: 0,
	outputCostPer1M: 0,
	totalCost: 0,
	cacheDiscount: 0,
	unpricedTokens: 0,
}

const CHECKPOINT_ID = fixtureId.checkpoint('validation') as CheckpointId

function checkpoint(overrides: Partial<IterationCheckpoint> = {}): IterationCheckpoint {
	return {
		id: CHECKPOINT_ID,
		runId: SCOPE.runId as RunId,
		runCreatedAt: 1_000,
		iteration: 2,
		messages: [createUserMessage('do the work')],
		tokenUsage: { ...ZERO_USAGE },
		costInfo: { ...ZERO_COST },
		guardState: { iterationCount: 2, elapsedMs: 500 },
		createdAt: 1_500,
		...overrides,
	}
}

async function storeHolding(overrides: Partial<IterationCheckpoint>): Promise<{
	store: InMemoryCheckpointStore
	manager: CheckpointManager
}> {
	const store = new InMemoryCheckpointStore()
	await store.writeCheckpoint(SCOPE, checkpoint(overrides))
	return { store, manager: new CheckpointManager(store, SCOPE) }
}

describe('the attempt counters a resume restores', () => {
	it('refuses a negative answer-review count', async () => {
		const { manager } = await storeHolding({ answerReviewAttempts: -1 })

		// A negative allowance is not "no attempts left" — it is a record
		// that was corrupted, and a run that trusted it would compare against
		// it forever.
		await expect(manager.restore(CHECKPOINT_ID)).rejects.toThrow(
			'Checkpoint answerReviewAttempts must be a nonnegative safe integer',
		)
	})

	it('refuses a structured-review count that is not a safe integer', async () => {
		const { manager } = await storeHolding({ structuredReviewAttempts: -3 })

		await expect(manager.restore(CHECKPOINT_ID)).rejects.toThrow(
			'Checkpoint structuredReviewAttempts must be a nonnegative safe integer',
		)
	})

	it('refuses a native-structured count that is not a safe integer', async () => {
		const { manager } = await storeHolding({ nativeStructuredAttempts: 1.5 })

		await expect(manager.restore(CHECKPOINT_ID)).rejects.toThrow(
			'Invalid nativeStructuredAttempts in checkpoint',
		)
	})

	it('refuses a non-finite count rather than treating it as unbounded', async () => {
		const { manager } = await storeHolding({ nativeStructuredAttempts: Number.POSITIVE_INFINITY })

		// `Number.isSafeInteger(Infinity)` is false, which is the point: a
		// counter that can never be reached reads as "retry forever".
		await expect(manager.restore(CHECKPOINT_ID)).rejects.toThrow(
			'Invalid nativeStructuredAttempts in checkpoint',
		)
	})

	it('restores each mode its own count, so one does not reset another', async () => {
		// The three are separate budgets in the loop, and a restore that
		// crossed them would spend the answer-review allowance on a
		// structured-output retry.
		const { manager } = await storeHolding({
			answerReviewAttempts: 1,
			structuredReviewAttempts: 2,
			nativeStructuredAttempts: 3,
		})

		await manager.restore(CHECKPOINT_ID)

		expect(manager.restoredAnswerReviewAttempts).toBe(1)
		expect(manager.restoredStructuredReviewAttempts).toBe(2)
		expect(manager.restoredNativeStructuredAttempts).toBe(3)
	})

	it('reads a checkpoint written before these counters existed as zero attempts', async () => {
		// Absent is a real answer and not a guess: every checkpoint written
		// before the counters existed describes a run that had spent none.
		const { manager } = await storeHolding({})

		await manager.restore(CHECKPOINT_ID)

		expect(manager.restoredAnswerReviewAttempts).toBe(0)
		expect(manager.restoredStructuredReviewAttempts).toBe(0)
		expect(manager.restoredNativeStructuredAttempts).toBe(0)
	})
})

describe('the operator intent a checkpoint carries', () => {
	it('brings the message back, with its timestamp, on restore', async () => {
		const { manager } = await storeHolding({
			latestUserMessage: {
				role: 'user',
				content: 'ship the release',
				timestamp: 1_700_000_000_000,
			},
		})

		await manager.restore(CHECKPOINT_ID)

		// The getter had no reader anywhere in the suite before this: the
		// iteration loop reads it to re-seed the run's intent, so a restore
		// that dropped it would send the resumed run back to a prompt hook
		// with no topic.
		expect(manager.restoredLatestUserMessage).toEqual({
			role: 'user',
			content: 'ship the release',
			timestamp: 1_700_000_000_000,
		})
	})

	it('leaves the intent absent when the checkpoint carried none', async () => {
		const { manager } = await storeHolding({})

		await manager.restore(CHECKPOINT_ID)

		expect(manager.restoredLatestUserMessage).toBeUndefined()
	})

	it('refuses a timestamp it cannot believe', async () => {
		// The existing validation fixture tries four malformed intents and
		// this is not one of them. `NaN` and `Infinity` both survive a
		// `typeof === 'number'` check, and a resumed run that treated either
		// as an instant would place the operator's message at no time at all.
		for (const timestamp of [Number.NaN, Number.POSITIVE_INFINITY, 'yesterday']) {
			const { manager } = await storeHolding({
				latestUserMessage: { role: 'user', content: 'ship it', timestamp } as never,
			})

			await expect(manager.restore(CHECKPOINT_ID)).rejects.toThrow(
				'Checkpoint latestUserMessage has invalid operator intent or provenance',
			)
		}
	})

	it('refuses a provenance that is not an object rather than dropping it', async () => {
		// Dropping an unrecognised `source` would be the tempting repair and
		// the wrong one: the resumed run would treat a goal round's
		// instruction as an ordinary operator turn.
		const { manager } = await storeHolding({
			latestUserMessage: {
				role: 'user',
				content: 'round two',
				source: 'goal-round',
			} as never,
		})

		await expect(manager.restore(CHECKPOINT_ID)).rejects.toThrow(
			'Checkpoint latestUserMessage has invalid operator intent or provenance',
		)
	})

	it('keeps a steering provenance, which is what makes it unattributable to the operator', async () => {
		const { manager } = await storeHolding({
			latestUserMessage: {
				role: 'user',
				content: 'actually, hold off',
				source: { type: 'runtime-context', kind: 'steering' },
			} as never,
		})

		await manager.restore(CHECKPOINT_ID)

		expect(manager.restoredLatestUserMessage?.source).toEqual({
			type: 'runtime-context',
			kind: 'steering',
		})
	})
})
