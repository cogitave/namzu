import { describe, expect, it } from 'vitest'

import { createUserMessage } from '../../../types/message/index.js'
import { CheckpointDocumentError, parseCheckpoint } from '../../../types/session/checkpoint.js'
import { CheckpointManager } from '../checkpoint.js'
import { checkpointRecords, sessionWithCheckpoint } from './support/session.js'

/**
 * A checkpoint is the one thing a resumed turn is not allowed to be wrong
 * about. The document is validated on every read and write, and restore
 * validates the operator intent it names; a value that cannot be believed
 * stops the resume rather than being coerced. Coercing `-1` to `0` would
 * hand a turn a fresh retry allowance it had already spent.
 */

async function managerFor(options: Parameters<typeof sessionWithCheckpoint>[0] = {}) {
	const session = await sessionWithCheckpoint(options)
	return {
		session,
		manager: new CheckpointManager(checkpointRecords(session), session.store, session.scope),
	}
}

describe('the attempt counters a resume restores', () => {
	it('refuses a checkpoint whose counts are not nonnegative safe integers', async () => {
		const { session } = await managerFor()
		const document = (await session.store.read(session.scope, session.checkpointId)) ?? undefined
		for (const review of [
			{ structuredAttempts: 0, answerAttempts: -1, nativeStructuredAttempts: 0 },
			{ structuredAttempts: -3, answerAttempts: 0, nativeStructuredAttempts: 0 },
			{ structuredAttempts: 0, answerAttempts: 0, nativeStructuredAttempts: 1.5 },
			{
				structuredAttempts: 0,
				answerAttempts: 0,
				nativeStructuredAttempts: Number.POSITIVE_INFINITY,
			},
		]) {
			// A negative allowance is not "no attempts left" — it is a record that
			// was corrupted, and a turn that trusted it would compare against it
			// forever. `Infinity` would read as "retry forever".
			expect(() => parseCheckpoint({ ...document, review })).toThrow(CheckpointDocumentError)
		}
	})

	it('restores each mode its own count, so one does not reset another', async () => {
		// The three are separate budgets in the loop, and a restore that
		// crossed them would spend the answer-review allowance on a
		// structured-output retry.
		const { manager, session } = await managerFor({
			document: {
				review: { answerAttempts: 1, structuredAttempts: 2, nativeStructuredAttempts: 3 },
			},
		})

		await manager.restore(session.checkpointId)

		expect(manager.restoredAnswerReviewAttempts).toBe(1)
		expect(manager.restoredStructuredReviewAttempts).toBe(2)
		expect(manager.restoredNativeStructuredAttempts).toBe(3)
	})

	it('restores zero attempts from a checkpoint that spent none', async () => {
		const { manager, session } = await managerFor()

		await manager.restore(session.checkpointId)

		expect(manager.restoredAnswerReviewAttempts).toBe(0)
		expect(manager.restoredStructuredReviewAttempts).toBe(0)
		expect(manager.restoredNativeStructuredAttempts).toBe(0)
	})
})

describe('the operator intent a checkpoint names', () => {
	it('brings the message back, with its timestamp, on restore', async () => {
		const { manager, session } = await managerFor({
			messages: [{ role: 'user', content: 'ship the release', timestamp: 1_700_000_000_000 }],
			latestUserMessageIndex: 0,
		})

		await manager.restore(session.checkpointId)

		// The iteration loop reads it to re-seed the turn's intent, so a restore
		// that dropped it would send the resumed turn back to a prompt hook with
		// no topic.
		expect(manager.restoredLatestUserMessage).toEqual({
			role: 'user',
			content: 'ship the release',
			timestamp: 1_700_000_000_000,
		})
	})

	it('leaves the intent absent when the checkpoint names none', async () => {
		const { manager, session } = await managerFor()

		await manager.restore(session.checkpointId)

		expect(manager.restoredLatestUserMessage).toBeUndefined()
	})

	it('refuses a timestamp it cannot believe', async () => {
		// A resumed turn that treated an unbelievable timestamp as an instant
		// would place the operator's message at no time at all.
		for (const timestamp of [Number.POSITIVE_INFINITY, 'yesterday']) {
			const { manager, session } = await managerFor({
				messages: [{ role: 'user', content: 'ship it', timestamp } as never],
				latestUserMessageIndex: 0,
			})

			await expect(manager.restore(session.checkpointId)).rejects.toThrow(
				'Checkpoint latestUserMessage has invalid operator intent or provenance',
			)
		}
	})

	it('refuses a provenance that is not an object rather than dropping it', async () => {
		// Dropping an unrecognised `source` would treat a goal round's
		// instruction as an ordinary operator turn.
		const { manager, session } = await managerFor({
			messages: [{ role: 'user', content: 'round two', source: 'goal-round' } as never],
			latestUserMessageIndex: 0,
		})

		await expect(manager.restore(session.checkpointId)).rejects.toThrow(
			'Checkpoint latestUserMessage has invalid operator intent or provenance',
		)
	})

	it('keeps a steering provenance, which is what makes it unattributable to the operator', async () => {
		const { manager, session } = await managerFor({
			messages: [
				createUserMessage('first'),
				{
					role: 'user',
					content: 'actually, hold off',
					source: { type: 'runtime-context', kind: 'steering' },
				} as never,
			],
			latestUserMessageIndex: 1,
		})

		await manager.restore(session.checkpointId)

		expect(manager.restoredLatestUserMessage?.source).toEqual({
			type: 'runtime-context',
			kind: 'steering',
		})
	})
})
