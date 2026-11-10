import type { CheckpointId, SessionId, TurnId } from '../../types/ids/index.js'
import { type TurnOutcome, TurnOutcomeSchema } from '../../types/session/outcome.js'
import type { SessionRecord } from '../../types/session/records.js'
import type { SessionLog } from './core.js'

/**
 * Reading the turn's outcome record back out of the session log.
 *
 * It lives in three records of its own (`turn_outcome_recorded`,
 * `child_outcome_recorded`, `outcome_progress_written`), each flagged
 * `ignorable`, and never in a field of an older record: a release that
 * validates `turn_completed`, `child_session_ended` or the checkpoint strictly
 * reads a log that has them and loses only the outcome. The fold of messages
 * does not look at them. A body that does not parse as a `TurnOutcome` reads
 * as no outcome, never as a guess.
 */

/** `value` as a {@link TurnOutcome}, or `undefined` when it is not one. */
export function parseTurnOutcome(value: unknown): TurnOutcome | undefined {
	const parsed = TurnOutcomeSchema.safeParse(value)
	return parsed.success ? parsed.data : undefined
}

/**
 * The outcome of each turn that recorded one, from records in log order. A
 * turn that recorded none is absent, so a caller never reads `unchanged` into
 * a turn nobody measured.
 */
export function foldTurnOutcomes(records: Iterable<SessionRecord>): Map<TurnId, TurnOutcome> {
	const outcomes = new Map<TurnId, TurnOutcome>()
	for (const record of records) {
		if (record.type !== 'turn_outcome_recorded') continue
		const outcome = parseTurnOutcome(record.outcome)
		if (outcome) outcomes.set(record.turnId, outcome)
		else outcomes.delete(record.turnId)
	}
	return outcomes
}

/** The outcome `turnId` recorded, or `undefined`. */
export async function readTurnOutcome(
	log: SessionLog,
	turnId: TurnId,
): Promise<TurnOutcome | undefined> {
	let found: TurnOutcome | undefined
	for await (const { record } of log.read({ mode: 'tolerant' })) {
		if (record.type !== 'turn_outcome_recorded' || record.turnId !== turnId) continue
		found = parseTurnOutcome(record.outcome)
	}
	return found
}

/**
 * The outcome a child's settled turn recorded in the parent's log, by child
 * session id. A child with no record is absent.
 */
export function foldChildOutcomes(records: Iterable<SessionRecord>): Map<SessionId, TurnOutcome> {
	const outcomes = new Map<SessionId, TurnOutcome>()
	for (const record of records) {
		if (record.type !== 'child_outcome_recorded') continue
		const outcome = parseTurnOutcome(record.outcome)
		if (outcome) outcomes.set(record.childSessionId, outcome)
		else outcomes.delete(record.childSessionId)
	}
	return outcomes
}

/**
 * What the outcome record had gathered when `checkpointId` was written, or
 * `undefined` when no progress record names it (a checkpoint written before
 * the record existed, or by a release that does not write it).
 */
export async function readOutcomeProgress(
	log: SessionLog,
	checkpointId: CheckpointId,
): Promise<Readonly<Record<string, unknown>> | undefined> {
	let found: Readonly<Record<string, unknown>> | undefined
	for await (const { record } of log.read({ mode: 'tolerant' })) {
		if (record.type === 'outcome_progress_written' && record.checkpointId === checkpointId) {
			found = record.progress
		}
	}
	return found
}
