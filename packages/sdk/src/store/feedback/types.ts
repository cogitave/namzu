import type { MessageId, RunId } from '../../types/ids/index.js'

/**
 * Was that answer any good — recorded per message, durably.
 *
 * Nothing in this tree stored a per-message judgment, and every ingredient
 * for one already existed: `MessageId` is a branded type, run events carry
 * it, and the versioned-store idiom with compare-and-set is established in
 * three neighbouring stores. So every consumer — the CLI, a gateway, a
 * future UI — had to invent its own side table to answer the most basic
 * question there is, which is also the input to session review, support
 * triage and eval collection.
 */

/**
 * Two values, closed.
 *
 * Not a number, and not an open string. A 1–5 scale invites a mean nobody
 * can interpret across raters, and an open string turns every consumer into
 * a parser of somebody else's vocabulary. Widening this later is then a
 * deliberate `major` with a migration, rather than the accident that a
 * `number` would have made inevitable.
 */
export type FeedbackRating = 'good' | 'bad'

export interface MessageFeedback {
	readonly runId: RunId
	readonly messageId: MessageId
	readonly rating: FeedbackRating
	/** Whatever the rater wanted to say. Absent is different from empty. */
	readonly note?: string
	/**
	 * Compare-and-set counter, starting at 1 for a record's first write.
	 *
	 * The same mechanism the topic store uses, and for the same reason: two
	 * writers racing on one record must not have the second silently
	 * overwrite the first. A rating is exactly the kind of value where
	 * last-write-wins loses information nobody notices is gone.
	 */
	readonly ownerVersion: number
	readonly createdAt: number
	readonly updatedAt: number
}

export interface PutMessageFeedbackInput {
	readonly runId: RunId
	readonly messageId: MessageId
	readonly rating: FeedbackRating
	readonly note?: string
	/**
	 * The version the caller believes is current — `0` for a first write.
	 *
	 * Required rather than optional. An optional expected version reads as
	 * "I do not care", and a caller who does not care is the caller whose
	 * write silently discards somebody else's.
	 */
	readonly expectedVersion: number
}

export interface MessageFeedbackStore {
	putMessageFeedback(input: PutMessageFeedbackInput): Promise<MessageFeedback>
	listMessageFeedback(query: { readonly runId: RunId }): Promise<readonly MessageFeedback[]>
}

/** A write whose `expectedVersion` no longer matches what is stored. */
export class StaleFeedbackError extends Error {
	readonly details: {
		runId: RunId
		messageId: MessageId
		expectedVersion: number
		actualVersion: number
	}

	constructor(details: {
		runId: RunId
		messageId: MessageId
		expectedVersion: number
		actualVersion: number
	}) {
		super(
			`Stale feedback for ${details.messageId} in ${details.runId}: expected ownerVersion=${details.expectedVersion}, actual=${details.actualVersion}`,
		)
		this.name = 'StaleFeedbackError'
		this.details = details
	}
}

/**
 * A rating aimed at a message the named run never produced.
 *
 * Refused rather than stored, per `refuse-do-not-degrade`. A feedback table
 * is read later to answer "which answers were bad" — a row pointing at a
 * message that does not exist cannot be reviewed, cannot be traced back to
 * what was said, and is indistinguishable from a real one. Storing it costs
 * nothing at write time and poisons every read after it.
 */
export class UnknownMessageError extends Error {
	readonly details: { runId: RunId; messageId: MessageId }

	constructor(details: { runId: RunId; messageId: MessageId }) {
		super(
			`No message ${details.messageId} in run ${details.runId}: feedback must name a message the run actually produced.`,
		)
		this.name = 'UnknownMessageError'
		this.details = details
	}
}
