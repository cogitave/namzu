import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
import type { CheckpointId, PendingDecision } from '../hitl/index.js'
import type { RunId, SessionId, TenantId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ProjectId, ThreadId } from '../session/ids.js'
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
	 * Schema version. Bumped when the shape changes incompatibly, so a
	 * host that stored a snapshot with an older SDK gets a clear failure
	 * from {@link parseRunState} instead of a partial restore.
	 */
	readonly version: 1

	readonly runId: RunId
	readonly sessionId: SessionId
	readonly threadId: ThreadId
	readonly projectId: ProjectId
	readonly tenantId: TenantId
	/** Present for sub-runs, so a hierarchical store can key the snapshot. */
	readonly parentRunId?: RunId

	readonly agentId?: string
	readonly agentName?: string

	readonly status: AgentStatus
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

export const RUN_STATE_VERSION = 1 as const

/**
 * Parse a serialized snapshot, refusing anything this SDK cannot fully
 * restore.
 *
 * The version guard is the point. A snapshot is written by one deployment
 * and read by another, possibly weeks later and possibly after an SDK
 * upgrade; a silent partial restore there produces a run that looks healthy
 * and has lost its budgets. Failing loudly is the only honest option.
 */
export function parseRunState(json: string | unknown): RunState {
	const raw: unknown = typeof json === 'string' ? JSON.parse(json) : json
	if (typeof raw !== 'object' || raw === null) {
		throw new RunStateVersionError(raw, RUN_STATE_VERSION)
	}
	const version = (raw as { version?: unknown }).version
	if (version !== RUN_STATE_VERSION) {
		throw new RunStateVersionError(version, RUN_STATE_VERSION)
	}
	return raw as RunState
}
