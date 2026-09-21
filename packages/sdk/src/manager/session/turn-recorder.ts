import type { SessionTokenBudget } from '../../store/budget/index.js'
import type { SessionLog } from '../../store/session-log/index.js'
import type { AuditEventInput } from '../../types/session/audit.js'
import type { TurnRecorderConfig } from '../../types/session/config.js'
import type { SessionId, TurnId } from '../../types/session/ids.js'
import type { Turn } from '../../types/session/turn.js'

/** Which provider and model a cost is priced against. */
export interface PricingSubject {
	readonly providerId: string
	readonly model: string | undefined
}

/**
 * Records one turn into its session log: `turn_started`, every `message`
 * when the message ends (not when the turn ends), checkpoints, audit
 * entries, and the settling `turn_completed`/`turn_failed`. When the final
 * `result` differs from the text of the turn's last assistant message it
 * appends `message_replaced` first, so every fold shows the answer the host
 * was given.
 *
 * It writes under the session lease and holds no other durable state: no
 * `run.json`, `messages.json` or `report.md`.
 *
 * API freeze: the constructor and members below are the contract; the body
 * is wired in the turn-core workstream.
 */
export class TurnRecorder {
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly budget?: SessionTokenBudget
	readonly log: SessionLog

	constructor(config: TurnRecorderConfig) {
		this.sessionId = config.sessionId
		this.turnId = config.turnId
		this.budget = config.budget
		this.log = config.sessionLog
		throw new Error('train: not yet wired')
	}

	/** The turn as it stands. */
	get turn(): Turn {
		throw new Error('train: not yet wired')
	}

	/**
	 * Append an `audit` record. Refuses rather than dropping the entry: an
	 * audit trail nobody can point at is not a degraded feature.
	 */
	async recordAudit(_input: AuditEventInput): Promise<void> {
		throw new Error('train: not yet wired')
	}
}
