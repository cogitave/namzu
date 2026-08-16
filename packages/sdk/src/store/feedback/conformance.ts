import type { MessageId, RunId } from '../../types/ids/index.js'
import type { MessageFeedbackStore } from './types.js'

/**
 * The feedback-store contract, as a suite either implementation runs.
 *
 * Two built-in stores that agree by inspection is not the same as two that
 * agree. The checkpoint stores diverged at exactly their enforcement point
 * once already — the in-memory one accepted a write the disk one refused,
 * and the class documented as "the reference a host reads" was the one
 * carrying the defect. Reading a reference cannot catch that; running it
 * can.
 *
 * The rules here are the ones no type states: that a stale write is refused
 * and changes nothing, that exactly one of two racing writers wins, that a
 * rating aimed at a message the run never produced is refused, and that a
 * listing answers for the run it was asked about and no other.
 *
 * Takes its runner as an argument for the same reason the checkpoint suite
 * does: this file imports no test framework, so the package gains no test
 * dependency from shipping it, and a caller can pass RECORDING functions
 * and run the whole contract as ordinary code.
 */

export interface FeedbackConformanceOptions {
	readonly describe: (name: string, body: () => void) => void
	readonly it: (name: string, body: () => Promise<void> | void) => void
	readonly expect: (actual: unknown) => {
		toBe(expected: unknown): void
		toEqual(expected: unknown): void
		toHaveLength(n: number): void
	}
	readonly label: string
	/** A fresh store, plus the ids its message check will accept. */
	readonly makeStore: () => Promise<{
		store: MessageFeedbackStore
		runId: RunId
		knownMessageId: MessageId
		/** Syntactically valid and never produced by `runId`. */
		unknownMessageId: MessageId
		otherRunId: RunId
		otherKnownMessageId: MessageId
	}>
}

export function defineMessageFeedbackConformance(options: FeedbackConformanceOptions): void {
	const { describe, it, expect, makeStore } = options

	describe(`message feedback contract: ${options.label}`, () => {
		it('starts a record at version 1', async () => {
			const { store, runId, knownMessageId } = await makeStore()

			const record = await store.putMessageFeedback({
				runId,
				messageId: knownMessageId,
				rating: 'good',
				expectedVersion: 0,
			})

			expect(record.ownerVersion).toBe(1)
			expect(record.rating).toBe('good')
		})

		it('refuses a stale write and leaves the record untouched', async () => {
			// Re-read after the throw, deliberately. A store that threw AFTER
			// writing would satisfy "it throws" and have already lost the
			// first rater's answer.
			const { store, runId, knownMessageId } = await makeStore()
			await store.putMessageFeedback({
				runId,
				messageId: knownMessageId,
				rating: 'good',
				expectedVersion: 0,
			})

			let threw = false
			try {
				await store.putMessageFeedback({
					runId,
					messageId: knownMessageId,
					rating: 'bad',
					expectedVersion: 0,
				})
			} catch (err) {
				threw = true
				expect((err as { details?: { expectedVersion: number } }).details?.expectedVersion).toBe(0)
				expect((err as { details?: { actualVersion: number } }).details?.actualVersion).toBe(1)
			}

			expect(threw).toBe(true)
			const listed = await store.listMessageFeedback({ runId })
			expect(listed).toHaveLength(1)
			expect(listed[0]?.rating).toBe('good')
			expect(listed[0]?.ownerVersion).toBe(1)
		})

		it('lets exactly one of two racing writers through', async () => {
			// Both start from version 0, which is what two raters who each
			// read "no feedback yet" actually hold. Under last-write-wins both
			// succeed and the surviving version is 1 by coincidence rather
			// than by exclusion, so the version is asserted numerically.
			const { store, runId, knownMessageId } = await makeStore()
			const attempts = ['good', 'bad'].map((rating) =>
				store
					.putMessageFeedback({
						runId,
						messageId: knownMessageId,
						rating: rating as 'good' | 'bad',
						expectedVersion: 0,
					})
					.then(
						() => 'ok' as const,
						() => 'refused' as const,
					),
			)
			const outcomes = await Promise.all(attempts)

			expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1)
			expect(outcomes.filter((o) => o === 'refused')).toHaveLength(1)
			const listed = await store.listMessageFeedback({ runId })
			expect(listed).toHaveLength(1)
			expect(listed[0]?.ownerVersion).toBe(1)
		})

		it('advances the version on a correct update', async () => {
			const { store, runId, knownMessageId } = await makeStore()
			await store.putMessageFeedback({
				runId,
				messageId: knownMessageId,
				rating: 'good',
				expectedVersion: 0,
			})

			const second = await store.putMessageFeedback({
				runId,
				messageId: knownMessageId,
				rating: 'bad',
				note: 'changed my mind',
				expectedVersion: 1,
			})

			expect(second.ownerVersion).toBe(2)
			expect(second.rating).toBe('bad')
			expect(second.note).toBe('changed my mind')
		})

		it('refuses a message the run never produced, and writes nothing', async () => {
			const { store, runId, unknownMessageId } = await makeStore()

			let threw = false
			try {
				await store.putMessageFeedback({
					runId,
					messageId: unknownMessageId,
					rating: 'good',
					expectedVersion: 0,
				})
			} catch {
				threw = true
			}

			expect(threw).toBe(true)
			expect(await store.listMessageFeedback({ runId })).toHaveLength(0)
		})

		it('answers for the run it was asked about and no other', async () => {
			const { store, runId, knownMessageId, otherRunId, otherKnownMessageId } = await makeStore()
			await store.putMessageFeedback({
				runId,
				messageId: knownMessageId,
				rating: 'good',
				expectedVersion: 0,
			})
			await store.putMessageFeedback({
				runId: otherRunId,
				messageId: otherKnownMessageId,
				rating: 'bad',
				expectedVersion: 0,
			})

			const mine = await store.listMessageFeedback({ runId })

			expect(mine).toHaveLength(1)
			expect(mine[0]?.messageId).toBe(knownMessageId)
		})

		it('lists nothing for a run with no feedback', async () => {
			const { store, otherRunId } = await makeStore()

			expect(await store.listMessageFeedback({ runId: otherRunId })).toHaveLength(0)
		})
	})
}
