import { SESSION_STATUS_READ_MODEL_ID, createSessionStatusReadModel } from '../read-model/index.js'
import type { SessionStatusState } from '../read-model/index.js'
import { ReadModelRegistry } from '../read-model/registry.js'
import {
	type SessionLog,
	SpillIntegrityError,
	SpillUnavailableError,
	foldSessionMessages,
} from '../store/session-log/index.js'
import type { Message } from '../types/message/index.js'
import type { SessionRecord, TurnStatus } from '../types/session/index.js'

/**
 * Asking a session what happened, from its log.
 *
 * The log is the one source: `records()` is every record, the fold is the
 * conversation that survived compaction, and `compaction_shed` carries
 * exactly the messages each pass removed, in their original order — so
 * "everything that was ever in this conversation" has one answer.
 */

export interface SessionQueryOptions {
	/** The session log to ask. */
	readonly log: SessionLog
	/** Injectable for the same reason the read model injects it. */
	readonly now?: () => number
}

export type SessionTranscriptUnavailableReason =
	/** A record of the log does not chain to the one before it. */
	| 'log-integrity'
	/** A message body was spilled and the spill cannot be read or verified. */
	| 'spill-unavailable'

/**
 * Refusal to call a partial or unverifiable reconstruction "complete".
 */
export class SessionTranscriptUnavailableError extends Error {
	readonly reason: SessionTranscriptUnavailableReason
	/** The last record the log could vouch for. */
	readonly throughSeq: number | undefined

	constructor(input: {
		reason: SessionTranscriptUnavailableReason
		throughSeq?: number
		cause?: unknown
	}) {
		const detail =
			input.reason === 'log-integrity'
				? `the session log breaks after record ${input.throughSeq ?? 'unknown'}`
				: 'a spilled message body cannot be read back'
		super(
			`Complete session transcript unavailable: ${detail}.`,
			input.cause ? { cause: input.cause } : undefined,
		)
		this.name = 'SessionTranscriptUnavailableError'
		this.reason = input.reason
		this.throughSeq = input.throughSeq
	}
}

/** What one compaction pass removed. */
export interface ShedPass {
	readonly iteration: number
	readonly reason: Extract<SessionRecord, { type: 'compaction_shed' }>['reason']
	readonly messages: readonly Message[]
	/** Where in the log the pass sits. */
	readonly seq: number
}

export class SessionQuery {
	constructor(private readonly options: SessionQueryOptions) {}

	/** The session's records, oldest first. Refused when the log does not chain. */
	async records(): Promise<readonly SessionRecord[]> {
		const read = await this.options.log.readAll({ mode: 'tolerant' })
		if (!read.intact) {
			throw new SessionTranscriptUnavailableError({
				reason: 'log-integrity',
				throughSeq: read.throughSeq,
				cause: read.break,
			})
		}
		return read.entries.map((entry) => entry.record)
	}

	/** Every message compaction removed, one entry per pass, oldest first. */
	async shedHistory(): Promise<readonly ShedPass[]> {
		return shedPassesFrom(await this.records())
	}

	/**
	 * Everything that was ever in this conversation: shed passes oldest
	 * first, then the conversation that survived (the fold of the log, or
	 * `messages` when given). Complete, not interleaved: the log records what
	 * each pass removed, not where its summary sits relative to what came
	 * after.
	 */
	async fullTranscript(messages?: readonly Message[]): Promise<readonly Message[]> {
		const records = await this.records()
		const shed = shedPassesFrom(records)
		let surviving: readonly Message[]
		if (messages !== undefined) {
			surviving = messages
		} else {
			try {
				surviving = await foldSessionMessages(records, {
					readSpill: (ref) => this.options.log.readSpill(ref),
				})
			} catch (error) {
				if (
					error instanceof SpillUnavailableError ||
					error instanceof SpillIntegrityError ||
					error instanceof SyntaxError
				)
					throw new SessionTranscriptUnavailableError({ reason: 'spill-unavailable', cause: error })
				throw error
			}
		}
		if (shed.length === 0) return surviving
		return [...shed.flatMap((pass) => pass.messages), ...surviving]
	}

	/** The session's status, folded from its own log through the read model. */
	async status(): Promise<TurnStatus> {
		return (await this.statusState()).status
	}

	/** The whole projected state, for a caller that wants the park too. */
	async statusState(): Promise<SessionStatusState> {
		const registry = new ReadModelRegistry()
		registry.register(
			createSessionStatusReadModel(this.options.now ? { now: this.options.now } : {}),
		)
		registry.replay(await this.records())
		return registry.get<SessionStatusState>(SESSION_STATUS_READ_MODEL_ID)
	}
}

function shedPassesFrom(records: readonly SessionRecord[]): ShedPass[] {
	const passes: ShedPass[] = []
	for (const record of records) {
		if (record.type !== 'compaction_shed') continue
		passes.push({
			iteration: record.iteration,
			reason: record.reason,
			messages: record.messages,
			seq: record.seq,
		})
	}
	return passes
}
