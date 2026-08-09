/**
 * Where a reconnecting consumer left off, and whether the kernel can honour it.
 *
 * The shortfall is a VALUE here, not a sentence in a document. A consumer that
 * asks for everything after sequence 400 and silently receives a splice from a
 * different generation of the run is wrong and has no way to find out; a
 * consumer handed `{ status: 'unavailable', reason: 'cursor_ahead' }` re-derives
 * from the transcript and is right. That is refuse-do-not-degrade applied to a
 * subscription rather than to a capability.
 */

import type { ClaimFence } from './checkpoint-store.js'
import type { PersistedRunEvent } from './events.js'

/** What a consumer holds when it comes back. */
export interface RunEventCursor {
	/**
	 * The last `seq` the consumer actually received, from the envelope. Zero —
	 * or the field absent — means "from the beginning".
	 */
	readonly sinceSeq: number
	/**
	 * The `generation` carried on the events the consumer received, when they
	 * carried one.
	 *
	 * Compared for equality only. Absent on both sides is not a match and not a
	 * mismatch: it is an unfenced run, where the sequence is the only evidence
	 * available and the log persisting is the assumption.
	 */
	readonly generation?: ClaimFence
}

/** Why a cursor could not be honoured. */
export type RunEventReplayRefusal =
	/**
	 * The consumer claims to have seen more than the log holds.
	 *
	 * The ordinary cause is not a lying client: it is a log that did not
	 * survive. An in-memory run store on a restarted process seeds at zero
	 * while the consumer still holds 400, and this is the verdict that says so
	 * instead of reporting a serene "you are up to date".
	 */
	| 'cursor_ahead'
	/**
	 * The run has been taken over since. The consumer's sequence numbers were
	 * minted under an older claim and address a different sequence space, so
	 * they are not comparable — not merely stale.
	 */
	| 'generation_changed'
	/**
	 * The store answered, and its oldest available event is above the one after
	 * the cursor. A pruning or windowed backend, caught at the boundary rather
	 * than delivered as a continuous stream with a hole in it.
	 */
	| 'gap'

/** What came of a cursor. */
export type RunEventReplay =
	/** The cursor is already at the log's head. Nothing was missed. */
	| { readonly status: 'complete' }
	/** Contiguous from `sinceSeq + 1`, oldest first. */
	| { readonly status: 'replayed'; readonly events: readonly PersistedRunEvent[] }
	/** Nothing is delivered. The consumer re-derives from the transcript. */
	| { readonly status: 'unavailable'; readonly reason: RunEventReplayRefusal }

/** The log's present state, as the store reports it. */
export interface RunEventLogHead {
	/** Highest sequence in the log; zero when it is empty. */
	readonly lastSeq: number
	/** The fence the run is being written under, when it holds a claim. */
	readonly generation?: ClaimFence
}

/**
 * Decide what a cursor is owed, given what the log holds.
 *
 * Pure, and ordered deliberately: a takeover invalidates the sequence space, so
 * comparing sequences across generations would be arithmetic on two different
 * scales. The generation check therefore runs FIRST, before the numbers are
 * allowed to mean anything.
 *
 * `events` is what the store returned for `{ sinceSeq: cursor.sinceSeq }`. It is
 * passed in rather than fetched here so this stays a function of its arguments
 * — the property "no gap, no duplicate" is decidable from the three inputs, and
 * a test can drive every branch without a store.
 */
export function resolveRunEventReplay(
	cursor: RunEventCursor,
	head: RunEventLogHead,
	events: readonly PersistedRunEvent[],
): RunEventReplay {
	// Both sides must carry one for a mismatch to mean anything. An unfenced run
	// has no generation to disagree with, and treating "absent" as a distinct
	// value would refuse every run that never took a claim — which is most of
	// them.
	if (
		cursor.generation !== undefined &&
		head.generation !== undefined &&
		cursor.generation !== head.generation
	) {
		return { status: 'unavailable', reason: 'generation_changed' }
	}

	if (cursor.sinceSeq > head.lastSeq) {
		return { status: 'unavailable', reason: 'cursor_ahead' }
	}

	if (cursor.sinceSeq === head.lastSeq) return { status: 'complete' }

	// The log says there is something above the cursor, so an empty answer is
	// the store contradicting its own head rather than "nothing to send".
	const first = events[0]
	if (!first || first.seq !== cursor.sinceSeq + 1) {
		return { status: 'unavailable', reason: 'gap' }
	}

	return { status: 'replayed', events }
}
