import {
	asCheckpointId,
	asProjectId,
	asSessionId,
	asTenantId,
	asTopicId,
	asTurnId,
} from '../../utils/id.js'
import type { CostInfo, TokenUsage } from '../common/index.js'
import type { CheckpointId, PendingDecision } from '../hitl/index.js'
import type { SessionId, TenantId, TurnId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ProjectId, TopicId } from './ids.js'
import type { StopReason } from './stop-reason.js'
import type { TurnBudgetBinding, TurnExecutionStatus } from './turn.js'

/**
 * Everything needed to pick a turn back up in a DIFFERENT process.
 *
 * A flat, JSON-safe snapshot: a serverless handler writes one when a turn
 * parks, returns, and a later invocation — a different container — reads it
 * back and continues the SAME turn (`resumeSession`).
 *
 * It is a SNAPSHOT, not a live handle. Nothing in it points at a socket, a
 * sandbox, a provider client, or an open file. `messages` is the fold of the
 * session log through the checkpoint.
 */
export interface TurnState {
	/** Schema version. Any other value is refused by {@link parseTurnState}. */
	readonly version: typeof TURN_STATE_VERSION

	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly topicId: TopicId
	readonly projectId: ProjectId
	readonly tenantId: TenantId
	/** Present on a child session's turn. */
	readonly parentSessionId?: SessionId
	/** Present on a child session's turn. */
	readonly parentTurnId?: TurnId

	readonly agentId?: string
	readonly agentName?: string

	readonly status: TurnExecutionStatus
	readonly stopReason?: StopReason
	readonly lastError?: string

	readonly messages: Message[]
	readonly tokenUsage: TokenUsage
	readonly costInfo: CostInfo
	readonly currentIteration: number
	readonly startedAt: number
	/**
	 * Wall-clock the turn has already consumed. Restored into the guard so a
	 * resumed turn does not get a fresh timeout budget.
	 */
	readonly elapsedMs: number

	/** The checkpoint this snapshot corresponds to, when one was written. */
	readonly checkpointId?: CheckpointId

	/** The decision the turn is parked on, if any. */
	readonly pending?: PendingDecision

	/** The ledger the turn spends from, keyed by (rootSessionId, rootTurnId). */
	readonly budgetBinding?: TurnBudgetBinding

	readonly capturedAt: number
}

/**
 * Thrown by {@link parseTurnState} when a snapshot cannot be trusted: an
 * unknown version, or a `RunState` written by an SDK before sessions and
 * turns replaced runs.
 */
export class TurnStateVersionError extends Error {
	constructor(
		readonly found: unknown,
		readonly expected: number,
		message?: string,
	) {
		super(
			message ??
				`TurnState version mismatch: snapshot declares ${JSON.stringify(found)}, this SDK reads ${expected}. Restoring across an incompatible version would silently drop fields; start a new turn instead.`,
		)
		this.name = 'TurnStateVersionError'
	}
}

export const TURN_STATE_VERSION = 1 as const

function requireEntityIds(record: Record<string, unknown>): Record<string, unknown> {
	const validators = {
		sessionId: asSessionId,
		turnId: asTurnId,
		parentSessionId: asSessionId,
		parentTurnId: asTurnId,
		projectId: asProjectId,
		tenantId: asTenantId,
		topicId: asTopicId,
		checkpointId: asCheckpointId,
	}
	for (const [field, validate] of Object.entries(validators)) {
		const value = record[field]
		if (value !== undefined) validate(value as string)
	}
	return record
}

/**
 * Parse a serialized snapshot, refusing anything this SDK cannot fully
 * restore.
 *
 * A `RunState` (it carries `runId`) is refused with a message that names it:
 * the turn model is gone and there is no migration. Resolve or abandon parked
 * runs on the previous major before upgrading.
 */
export function parseTurnState(json: string | unknown): TurnState {
	const raw: unknown = typeof json === 'string' ? JSON.parse(json) : json
	if (typeof raw !== 'object' || raw === null) {
		throw new TurnStateVersionError(raw, TURN_STATE_VERSION)
	}
	const record = raw as Record<string, unknown>
	if ('runId' in record) {
		throw new TurnStateVersionError(
			record.version,
			TURN_STATE_VERSION,
			`This is a RunState (version ${JSON.stringify(record.version)}), written before sessions and turns replaced runs. It cannot be resumed by this SDK; resolve or abandon it on the previous major.`,
		)
	}
	if (record.version !== TURN_STATE_VERSION) {
		throw new TurnStateVersionError(record.version, TURN_STATE_VERSION)
	}
	return requireEntityIds(record) as unknown as TurnState
}
