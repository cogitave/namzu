import { ReadModelRegistry } from '../read-model/registry.js'
import { RUN_STATUS_READ_MODEL_ID, createRunStatusReadModel } from '../read-model/run-status.js'
import type { RunStatusState } from '../read-model/run-status.js'
import type { Message } from '../types/message/index.js'
import type { PersistedRunEvent, RunStatus, RunStore } from '../types/run/index.js'

/**
 * Asking a finished run what happened.
 *
 * The stores could each answer part of it and nothing could answer the
 * question: `readEvents` gives a log, `writeMessages` persisted a history,
 * and the two disagree by design once compaction has run — the persisted
 * history is what SURVIVED, and what compaction removed lives only in the
 * event log. So "show me this conversation" had two plausible answers and a
 * caller picked one by accident.
 *
 * The compacted-away half is the reason this exists. `compaction_shed`
 * carries "exactly the messages the pass removed, in their original order",
 * shadowed to the transcript by NZ-RUNREC-06 precisely so it would not be
 * lost — and until now nothing read it back. Evidence nobody can retrieve
 * is evidence nobody kept.
 */

export interface RunQueryOptions {
	readonly store: RunStore
	/** Injectable for the same reason the read model injects it. */
	readonly now?: () => number
}

export type RunTranscriptUnavailableReason =
	| 'message-snapshot-not-persisted'
	| 'message-snapshot-unverified'
	| 'message-snapshot-out-of-sync'

/**
 * Refusal to call a partial or unverifiable reconstruction "complete".
 */
export class RunTranscriptUnavailableError extends Error {
	readonly reason: RunTranscriptUnavailableReason
	readonly eventHeadSeq: number | undefined
	readonly snapshotThroughEventSeq: number | undefined

	constructor(input: {
		reason: RunTranscriptUnavailableReason
		eventHeadSeq?: number
		snapshotThroughEventSeq?: number
	}) {
		const detail =
			input.reason === 'message-snapshot-not-persisted'
				? 'the surviving message snapshot was never persisted or its publication was interrupted'
				: input.reason === 'message-snapshot-unverified'
					? 'the surviving messages use the legacy format and carry no event-log boundary'
					: `the surviving message snapshot ends at event ${input.snapshotThroughEventSeq ?? 'unknown'}, but the durable log ends at event ${input.eventHeadSeq ?? 'unknown'}`
		super(`Complete run transcript unavailable: ${detail}.`)
		this.name = 'RunTranscriptUnavailableError'
		this.reason = input.reason
		this.eventHeadSeq = input.eventHeadSeq
		this.snapshotThroughEventSeq = input.snapshotThroughEventSeq
	}
}

/** What one compaction pass removed. */
export interface ShedPass {
	readonly iteration: number
	readonly reason: 'threshold' | 'overflow'
	readonly messages: readonly Message[]
	/** Where in the log the pass sits, for a caller correlating with events. */
	readonly seq: number
}

export class RunQuery {
	constructor(private readonly options: RunQueryOptions) {}

	/** The run's durable log, oldest first. */
	async events(): Promise<readonly PersistedRunEvent[]> {
		return await this.options.store.readEvents()
	}

	/**
	 * Every message compaction removed, one entry per pass, oldest first.
	 *
	 * Reads the log rather than any separate store, because the log is where
	 * the shed content already is — a second copy would be a second thing to
	 * keep in agreement, and the one that drifted would be the one somebody
	 * was reading during an incident.
	 */
	async shedHistory(): Promise<readonly ShedPass[]> {
		return shedPassesFrom(await this.events())
	}

	/**
	 * Everything that was ever in this conversation.
	 *
	 * Shed passes oldest first, then the run's surviving history — and the
	 * ordering claim is exactly that, no more. This does NOT reconstruct the
	 * original interleaving, and it cannot: the log records what each pass
	 * removed, not where the summary that replaced it was inserted relative
	 * to what came after. A caller wanting to know where a summary sits
	 * reads it in `messages`, where it still is.
	 *
	 * What it DOES guarantee is completeness: no message that was ever in
	 * the conversation is missing from this list, which is the question
	 * somebody reconstructing an incident is actually asking.
	 */
	async fullTranscript(messages?: readonly Message[]): Promise<readonly Message[]> {
		if (messages !== undefined) {
			const shed = await this.shedHistory()
			if (shed.length === 0) return messages
			return [...shed.flatMap((pass) => pass.messages), ...messages]
		}

		// Read the log first and compare the snapshot to that exact head. A
		// previous pause may have left a perfectly valid messages file under the
		// same run id; only the boundary says whether it belongs to THIS head.
		const events = await this.events()
		const eventHeadSeq = events.at(-1)?.seq ?? 0
		const snapshot = await this.options.store.readMessages()

		if (snapshot.kind === 'unavailable') {
			throw new RunTranscriptUnavailableError({
				reason: 'message-snapshot-not-persisted',
				eventHeadSeq,
			})
		}
		if (snapshot.kind === 'legacy-unverified') {
			throw new RunTranscriptUnavailableError({
				reason: 'message-snapshot-unverified',
				eventHeadSeq,
			})
		}
		if (snapshot.throughEventSeq !== eventHeadSeq) {
			throw new RunTranscriptUnavailableError({
				reason: 'message-snapshot-out-of-sync',
				eventHeadSeq,
				snapshotThroughEventSeq: snapshot.throughEventSeq,
			})
		}

		const shed = shedPassesFrom(events)
		if (shed.length === 0) return snapshot.messages
		return [...shed.flatMap((pass) => pass.messages), ...snapshot.messages]
	}

	/**
	 * The run's session-layer status, folded from its own log.
	 *
	 * Through the read model rather than a second projection: two folds of
	 * one log are two chances to disagree, and a run that reads differently
	 * depending on which surface asked is the defect this seam exists to
	 * remove.
	 */
	async status(): Promise<RunStatus> {
		return (await this.statusState()).status
	}

	/** The whole projected state, for a caller that wants the park too. */
	async statusState(): Promise<RunStatusState> {
		const registry = new ReadModelRegistry()
		registry.register(createRunStatusReadModel(this.options.now ? { now: this.options.now } : {}))
		registry.replay(await this.events())
		return registry.get<RunStatusState>(RUN_STATUS_READ_MODEL_ID)
	}
}

function shedPassesFrom(events: readonly PersistedRunEvent[]): ShedPass[] {
	const passes: ShedPass[] = []
	for (const event of events) {
		if (event.type !== 'compaction_shed') continue
		passes.push({
			iteration: event.iteration,
			reason: event.reason,
			messages: event.messages,
			seq: event.seq,
		})
	}
	return passes
}
