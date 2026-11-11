import { type SessionEvent, type TurnOutcome, parseTurnOutcome } from '@namzu/sdk'
import { outcomeLine } from '../tui/outcome-line.js'

/**
 * What a turn changed and what checked it, told to the desktop when the turn
 * ends. The kernel's record rides the turn's final event; the shared protocol
 * bridge does not carry it, so the desktop host says it itself, as one
 * `namzu/` notification per finished turn, beside the usage one.
 *
 * `line` is the terminal's own end-of-turn wording (`outcomeLine`), written
 * from the record and nothing else, so both hosts say the same words. Absent
 * means the record has nothing to say (nothing changed, no check failed).
 */
export const OUTCOME_NOTIFICATION = 'namzu/session/outcome'

export interface OutcomeNotification {
	readonly sessionId: string
	readonly turnId: string
	readonly verdict: TurnOutcome['verdict']
	/** The words for the line under the turn; absent when there are none. */
	readonly line?: string
	/** Files the turn's write tools changed. */
	readonly changed: number
	/** The record itself, bounded by the kernel. */
	readonly outcome: TurnOutcome
}

/** The notification a finished turn owes the desktop, or `undefined` when it recorded no outcome. */
export function outcomeNotification(
	sessionId: string,
	event: SessionEvent,
): OutcomeNotification | undefined {
	if (event.type !== 'turn_completed' && event.type !== 'turn_failed') return undefined
	const outcome = event.settlement.outcome
	if (!outcome) return undefined
	const line = outcomeLine(outcome)
	return {
		sessionId,
		turnId: event.turnId,
		verdict: outcome.verdict,
		...(line ? { line } : {}),
		changed: outcome.changes.total,
		outcome,
	}
}

/** Sends the notification for a finished turn through `notify`; a closed stream never fails the turn. */
export function announceOutcome(
	sessionId: string,
	event: SessionEvent,
	notify: (method: string, params: Record<string, unknown>) => void,
): void {
	const body = outcomeNotification(sessionId, event)
	if (!body) return
	try {
		notify(OUTCOME_NOTIFICATION, { ...body })
	} catch {
		/* A convenience for the view; the turn is already over. */
	}
}

/** What a saved conversation keeps of a turn's outcome: enough to draw the line, nothing of the record. */
export interface SavedTurnOutcome {
	readonly verdict: TurnOutcome['verdict']
	readonly line?: string
	readonly changed: number
}

/** The saved form of a record read back from the session log; a body that does not parse is no outcome. */
export function savedTurnOutcome(body: unknown): SavedTurnOutcome | undefined {
	const outcome = parseTurnOutcome(body)
	if (!outcome) return undefined
	const line = outcomeLine(outcome)
	return {
		verdict: outcome.verdict,
		...(line ? { line } : {}),
		changed: outcome.changes.total,
	}
}
