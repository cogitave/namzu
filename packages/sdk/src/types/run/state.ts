import type { CostInfo, RunExecutionStatus, TokenUsage } from '../common/index.js'
import type { CheckpointId, PendingDecision } from '../hitl/index.js'
import type { RunId, SessionId, TenantId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ProjectId, TopicId } from '../session/ids.js'
import type { StopReason } from './stop-reason.js'

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
	/**
	 * Schema version. A v1 snapshot (the pre-NZ-TOPIC-03 shape — `threadId`
	 * instead of `topicId`) and a v2 snapshot (the shape between NZ-TOPIC-03
	 * and NZ-TOPIC-04 — `topicId` already the field name, but its value can
	 * still carry the pre-narrowing `thd_` prefix) are both coerced forward
	 * by {@link parseRunState}; any other unrecognized version is refused
	 * with a clear failure rather than a partial restore, because silently
	 * dropping fields this build does not know about is the outcome worth
	 * failing loudly to avoid.
	 */
	readonly version: 3

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

export const RUN_STATE_VERSION = 3 as const

/** The shape `RunState` had before NZ-TOPIC-03: `threadId`, not `topicId`. */
const RUN_STATE_LEGACY_VERSION = 1

/**
 * The shape `RunState` had between NZ-TOPIC-03 and NZ-TOPIC-04: `topicId`
 * is already the field name, but its value can still carry the
 * pre-narrowing `thd_` prefix.
 */
const RUN_STATE_PRE_PREFIX_VERSION = 2

/**
 * Shared by both legacy branches below: rewrite a `thd_`-prefixed topicId
 * value to `top_`, leaving everything else — including an absent topicId —
 * untouched. Mirrors `store/session/disk.ts`'s
 * `migrateSessionStoreTopicIdPrefix`: same no-op-when-already-correct
 * shape, same reason (idempotence under a repeated migration pass).
 */
function rewriteLegacyTopicIdPrefix(record: Record<string, unknown>): Record<string, unknown> {
	const topicId = record.topicId
	if (typeof topicId !== 'string' || !topicId.startsWith('thd_')) return record
	return { ...record, topicId: `top_${topicId.slice('thd_'.length)}` }
}

/**
 * Parse a serialized snapshot, refusing anything this SDK cannot fully
 * restore.
 *
 * The version guard is the point. A snapshot is written by one deployment
 * and read by another, possibly weeks later and possibly after an SDK
 * upgrade; a silent partial restore there produces a run that looks healthy
 * and has lost its budgets. Failing loudly is the only honest option — for
 * every version this build does not otherwise recognize. Versions 1 and 2
 * are the exceptions: both are coerced forward rather than refused, the
 * same shape-tolerant rename `store/schema.ts`'s migrations use for the
 * on-disk session record, because a host that parks a run across either
 * release boundary would otherwise have every in-flight snapshot refused
 * on the way back in. `threadId` is renamed only when present (v1), and
 * a `thd_`-prefixed `topicId` is rewritten only when present (v1 and v2),
 * so a snapshot a host wrote with the field already absent, or already
 * `top_`-prefixed, does not gain a stamped or double-rewritten value.
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

	if (version === RUN_STATE_LEGACY_VERSION) {
		const { threadId, ...rest } = record
		const withTopicId = {
			...rest,
			...(threadId !== undefined ? { topicId: threadId } : {}),
		}
		return {
			...rewriteLegacyTopicIdPrefix(withTopicId),
			version: RUN_STATE_VERSION,
		} as RunState
	}

	if (version === RUN_STATE_PRE_PREFIX_VERSION) {
		return {
			...rewriteLegacyTopicIdPrefix(record),
			version: RUN_STATE_VERSION,
		} as RunState
	}

	if (version !== RUN_STATE_VERSION) {
		throw new RunStateVersionError(version, RUN_STATE_VERSION)
	}
	return raw as RunState
}
