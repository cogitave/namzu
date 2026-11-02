/**
 * Who may start a model turn right now, as data.
 *
 * Four things can start a turn with no person typing: the next queued prompt,
 * an admitted goal round, a peer's mail and a notice for work that ended while
 * nobody was talking. Each used to carry its own hand-copied list of
 * conditions. The lists agree on a core (the screen is idle and ready, nothing
 * is running or unwinding, and nothing is touching the conversation) and differ
 * on four points, which are the rows of {@link SOURCE_GATES}. The differences
 * are kept exactly as they were: unifying them would change what the person
 * sees, so a change to a row is a decision of its own, made on purpose.
 */

export type RoundSource = 'queue' | 'goal' | 'peer' | 'notice'

/** Everything a gate reads, taken at one instant. */
export interface RoundGateFacts {
	/** The screen shows no turn in progress. */
	readonly idle: boolean
	/** The session finished starting up. */
	readonly ready: boolean
	/** A provider is configured. */
	readonly hasProvider: boolean
	/** A turn holds the abort handle: it is running, or aborting and not yet released. */
	readonly turnRunning: boolean
	/** A turn that was aborted has not finished unwinding. */
	readonly unsettledTurn: boolean
	readonly pendingModelSwitch: boolean
	/** A fork, edit or rewind owns the conversation. */
	readonly conversationMutation: boolean
	readonly exporting: boolean
	readonly compacting: boolean
	/** A prompt for text, a choice or a copy is open on the screen. */
	readonly textPrompt: boolean
	readonly choicePicker: boolean
	readonly copyPicker: boolean
	/** A /goal command is still writing. */
	readonly goalCommandInFlight: boolean
	/** The goal driver already has an admission on disk. */
	readonly goalAdmissionInFlight: boolean
	readonly queueLength: number
	/** The queue is held after a failed or stopped reply. */
	readonly queuePaused: boolean
	/** A wake notice is already waiting in the queue. */
	readonly noticeQueued: boolean
}

/** What differs between the sources. Everything not listed here is the shared core. */
export interface SourceGate {
	/** Runs although the queue is held. */
	readonly ignoresPause: boolean
	/** Only runs when nothing is queued (a human prompt always goes first). */
	readonly needsEmptyQueue: boolean
	/** Only runs when something is queued. */
	readonly needsQueuedItem: boolean
	/** Needs a configured provider before it may even reserve a turn. */
	readonly needsProvider: boolean
	/** Not again while a notice of its own kind is already waiting. */
	readonly onePendingNotice: boolean
	/** Not again while its own previous reservation is still being written. */
	readonly oneInFlight: boolean
}

export const SOURCE_GATES: Readonly<Record<RoundSource, SourceGate>> = {
	queue: {
		ignoresPause: false,
		needsEmptyQueue: false,
		needsQueuedItem: true,
		needsProvider: false,
		onePendingNotice: false,
		oneInFlight: false,
	},
	goal: {
		ignoresPause: true,
		needsEmptyQueue: true,
		needsQueuedItem: false,
		needsProvider: true,
		onePendingNotice: false,
		oneInFlight: true,
	},
	peer: {
		ignoresPause: false,
		needsEmptyQueue: false,
		needsQueuedItem: false,
		needsProvider: false,
		onePendingNotice: false,
		oneInFlight: false,
	},
	notice: {
		ignoresPause: false,
		needsEmptyQueue: false,
		needsQueuedItem: false,
		needsProvider: false,
		onePendingNotice: true,
		oneInFlight: false,
	},
}

/** Why `source` may not start a turn now, or `null` when it may. */
export function admissionBlocked(source: RoundSource, facts: RoundGateFacts): string | null {
	const gate = SOURCE_GATES[source]
	if (gate.oneInFlight && facts.goalAdmissionInFlight) return 'its previous admission is in flight'
	if (!facts.idle) return 'a turn is in progress'
	if (!facts.ready) return 'the session is not ready'
	if (gate.needsProvider && !facts.hasProvider) return 'no provider is configured'
	if (gate.needsQueuedItem && facts.queueLength === 0) return 'nothing is queued'
	if (gate.needsEmptyQueue && facts.queueLength > 0) return 'a queued prompt goes first'
	if (!gate.ignoresPause && facts.queuePaused) return 'the queue is held'
	if (facts.turnRunning) return 'a turn is running'
	if (facts.unsettledTurn) return 'a turn is still unwinding'
	if (facts.pendingModelSwitch) return 'a model switch is pending'
	if (facts.conversationMutation) return 'the conversation is being changed'
	if (facts.exporting) return 'an export is running'
	if (facts.compacting) return 'the conversation is being compacted'
	if (facts.textPrompt) return 'a text prompt is open'
	if (facts.choicePicker) return 'a choice is open'
	if (facts.copyPicker) return 'a copy picker is open'
	if (facts.goalCommandInFlight) return 'a /goal command is running'
	if (gate.onePendingNotice && facts.noticeQueued) return 'a notice is already waiting'
	return null
}
