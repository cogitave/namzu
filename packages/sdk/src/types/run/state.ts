import {
	asCheckpointId,
	asProjectId,
	asRunId,
	asSessionId,
	asTenantId,
	asTopicId,
} from '../../utils/id.js'
import type { CostInfo, RunExecutionStatus, TokenUsage } from '../common/index.js'
import type { CheckpointId, PendingDecision } from '../hitl/index.js'
import type { RunId, SessionId, TenantId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ProjectId, TopicId } from '../session/ids.js'
import type { StopReason } from './stop-reason.js'
import { validateTokenBudgetBinding } from './token-budget-store.js'
import type { TokenBudgetBinding } from './token-budget-store.js'

/**
 * Everything needed to pick a run back up in a DIFFERENT process.
 *
 * A run's live state was spread across objects that only exist in memory —
 * `RunPersistence`, `GuardCoordinator`, the suspended `await` inside a HITL
 * gate. `IterationCheckpoint` carries the history and the budgets, but it
 * is keyed by a store scope the reader has to already know, and it says
 * nothing about the run's status or why it stopped. So "resume this run"
 * meant "the original process is still alive and holding it".
 *
 * That is the constraint this removes. `RunState` is a flat, JSON-safe
 * snapshot: a serverless handler writes one when a run parks, returns, and
 * a later invocation — a different container — reads it back and continues.
 *
 * It is a SNAPSHOT, not a live handle. Nothing in it points at a socket, a
 * sandbox, a provider client, or an open file. Re-establishing those is the
 * host's job on the way back in, which is exactly why they are absent.
 */
export interface RunState {
	/** Reference to the canonical tree ledger; a checkpoint never resets it. */
	readonly budgetBinding?: TokenBudgetBinding
	/** Also present for non-durable accounts; those require the live authority on resume. */
	readonly budgetAccountId?: string
	/**
	 * Schema version. Versions 1–3 are coerced forward by {@link parseRunState}.
	 * Version 4 carries aggregate token authority references; earlier readers
	 * must refuse it rather than silently discarding that authority on resume.
	 * Other unrecognized versions are refused instead of partially restored.
	 */
	readonly version: 4

	readonly runId: RunId
	readonly sessionId: SessionId
	readonly topicId: TopicId
	readonly projectId: ProjectId
	readonly tenantId: TenantId
	/** Present for sub-runs, so a hierarchical store can key the snapshot. */
	readonly parentRunId?: RunId

	readonly agentId?: string
	readonly agentName?: string

	readonly status: RunExecutionStatus
	readonly stopReason?: StopReason
	readonly lastError?: string

	readonly messages: Message[]
	readonly tokenUsage: TokenUsage
	readonly costInfo: CostInfo
	readonly currentIteration: number
	readonly startedAt: number
	/**
	 * Wall-clock the run has already consumed. Restored into the guard so a
	 * resumed run does not get a fresh timeout budget — the timeout is a
	 * property of the RUN, not of the process hosting it.
	 */
	readonly elapsedMs: number

	/**
	 * The checkpoint this snapshot corresponds to, when one was written.
	 * Pass it as `resumeFromCheckpoint`.
	 */
	readonly checkpointId?: CheckpointId

	/**
	 * The decision the run is parked on, if any. A host reads this to know
	 * what to ask a human, and feeds the answer back as
	 * `QueryParams.pendingDecision`.
	 */
	readonly pending?: PendingDecision

	readonly capturedAt: number
}

/** Thrown by {@link parseRunState} when a snapshot cannot be trusted. */
export class RunStateVersionError extends Error {
	constructor(
		readonly found: unknown,
		readonly expected: number,
	) {
		super(
			`RunState version mismatch: snapshot declares ${JSON.stringify(found)}, this SDK reads ${expected}. Restoring across an incompatible version would silently drop fields; re-run instead.`,
		)
		this.name = 'RunStateVersionError'
	}
}

export const RUN_STATE_VERSION = 4 as const

/** The shape `RunState` had before NZ-TOPIC-03: `threadId`, not `topicId`. */
const RUN_STATE_LEGACY_VERSION = 1

/**
 * The shape `RunState` had between NZ-TOPIC-03 and NZ-TOPIC-04: `topicId`
 * is already the field name, but its value can still carry the
 * pre-narrowing `thd_` prefix.
 */
const RUN_STATE_PRE_PREFIX_VERSION = 2

/** Before checkpoints referred to a canonical aggregate token ledger. */
const RUN_STATE_PRE_BUDGET_VERSION = 3

/** Require UUIDs on every supplied identity field without rewriting records. */
function requireEntityIds(record: Record<string, unknown>): Record<string, unknown> {
	if (record.budgetBinding !== undefined) validateTokenBudgetBinding(record.budgetBinding)
	if (record.budgetAccountId !== undefined) asRunId(record.budgetAccountId as string)
	const validators = {
		runId: asRunId,
		parentRunId: asRunId,
		sessionId: asSessionId,
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
 * The version guard is the point. A snapshot is written by one deployment
 * and read by another, possibly weeks later and possibly after an SDK
 * upgrade; a silent partial restore there produces a run that looks healthy
 * and has lost its budgets. Failing loudly is the only honest option — for
 * every version this build does not otherwise recognize. Versions 1 through 3
 * are the exceptions: they are coerced forward rather than refused, the
 * same shape-tolerant rename `store/schema.ts`'s migrations use for the
 * on-disk session record, because a host that parks a run across either
 * release boundary would otherwise have every in-flight snapshot refused
 * on the way back in. `threadId` is renamed only when present (v1), and
 * topic IDs are validated without changing their value. Retired `thd_`
 * values are refused; opaque UUIDs
 * are preserved. An absent topic field is not added.
 * Nothing here re-persists the coerced snapshot — a host that calls
 * `parseRunState` and then serializes the result back out upgrades the
 * record on THAT write, same as `store/schema.ts`'s "migrate on read,
 * re-stamp on next write" contract.
 *
 * A snapshot from a NEWER build read by an OLDER SDK is refused, not
 * partially restored: that SDK's `RUN_STATE_VERSION` is behind, so a
 * record's `version` matches neither the current version nor a legacy
 * version it knows how to coerce, and falls through to the throw below.
 */
export function parseRunState(json: string | unknown): RunState {
	const raw: unknown = typeof json === 'string' ? JSON.parse(json) : json
	if (typeof raw !== 'object' || raw === null) {
		throw new RunStateVersionError(raw, RUN_STATE_VERSION)
	}
	const record = raw as Record<string, unknown>
	const version = record.version
	if (
		(version === RUN_STATE_LEGACY_VERSION ||
			version === RUN_STATE_PRE_PREFIX_VERSION ||
			version === RUN_STATE_PRE_BUDGET_VERSION) &&
		(record.budgetBinding !== undefined || record.budgetAccountId !== undefined)
	) {
		throw new RunStateVersionError(version, RUN_STATE_VERSION)
	}

	if (version === RUN_STATE_LEGACY_VERSION) {
		const { threadId, ...rest } = record
		const withTopicId = {
			...rest,
			...(threadId !== undefined ? { topicId: threadId } : {}),
		}
		return {
			...requireEntityIds(withTopicId),
			version: RUN_STATE_VERSION,
		} as RunState
	}

	if (version === RUN_STATE_PRE_PREFIX_VERSION || version === RUN_STATE_PRE_BUDGET_VERSION) {
		return {
			...requireEntityIds(record),
			version: RUN_STATE_VERSION,
		} as RunState
	}

	if (version !== RUN_STATE_VERSION) {
		throw new RunStateVersionError(version, RUN_STATE_VERSION)
	}
	return requireEntityIds(record) as unknown as RunState
}
