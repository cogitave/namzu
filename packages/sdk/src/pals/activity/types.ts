import type { LogBytes } from '../../store/session-log/chain.js'
import type { SessionLog } from '../../store/session-log/core.js'
import type { ActivityStatus, ActivityType } from '../../types/activity/index.js'
import type {
	ActivityId,
	CheckpointId,
	ProjectId,
	SessionId,
	TenantId,
	ToolUseId,
	TurnId,
} from '../../types/ids/index.js'
import type { RecordPointer } from '../../types/session/records.js'
import type { PalStore } from '../types.js'

export interface PalActivityScope {
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly palId: string
	readonly profileRevision: number
	readonly sessionId: SessionId
}

/**
 * An unchanged previously emitted cursor, stored and resolved by the trusted host.
 * Never accept a model, renderer or remote client's anchor directly. scopeHash binds
 * ownership but does not authenticate a cursor; consumed prefixes are not rescanned.
 */
export interface PalActivityCursor {
	readonly v: 1
	readonly scopeHash: string
	readonly root: RecordPointer
	readonly after: RecordPointer
	readonly generation: number
}

export type PalActivityFactType =
	| 'turn_started'
	| 'turn_resuming'
	| 'turn_paused'
	| 'turn_completed'
	| 'turn_failed'
	| 'activity_created'
	| 'activity_updated'
	| 'tool_executing'
	| 'tool_completed'
	| 'tool_review_requested'
	| 'tool_review_completed'
	| 'checkpoint_created'

/** Allow-listed facts only. No descriptions, tool names, arguments, results or errors. */
export interface PalActivityFact {
	readonly id: string
	readonly type: PalActivityFactType
	readonly sessionId: SessionId
	readonly turnId?: TurnId
	readonly seq: number
	readonly generation: number
	readonly at: string
	readonly activityId?: ActivityId
	readonly activityType?: ActivityType
	readonly status?: ActivityStatus
	readonly toolUseId?: ToolUseId
	readonly checkpointId?: CheckpointId
	readonly reviewDecision?: 'approved' | 'modified' | 'rejected'
}

/** Host-owned read ports MUST address the same original journal, never a transcript cache. */
export interface PalActivityJournal {
	readonly log: Pick<SessionLog, 'sessionId'>
	readonly bytes: LogBytes
}

export interface PalActivitySourceOptions {
	readonly scope: PalActivityScope
	readonly pals: PalStore
	/** Current observation consent; checked before opening, original byte reads and output. */
	readonly authorize: (scope: PalActivityScope, signal: AbortSignal) => Promise<boolean>
	readonly openJournal: (
		scope: PalActivityScope,
		signal: AbortSignal,
	) => Promise<PalActivityJournal>
}

export interface PalActivityReadOptions {
	readonly signal: AbortSignal
	/** Trusted host-stored output of an earlier read; never untrusted client input. */
	readonly cursor?: PalActivityCursor
	/** Maximum new history records inspected, including omitted records, excluding anchors (1–256). */
	readonly maxRecords: number
	/** Total bytes requested from the journal, including root/cursor anchors (1–16 MiB). */
	readonly maxReadBytes: number
}

export interface PalActivityPage {
	readonly scope: PalActivityScope
	readonly facts: readonly PalActivityFact[]
	readonly cursor: PalActivityCursor
	/** Only the captured byte boundary was reached; later appends require another read. */
	readonly complete: boolean
	readonly scannedRecords: number
	readonly readBytes: number
}

export interface PalActivitySource {
	readonly scope: PalActivityScope
	read(options: PalActivityReadOptions): Promise<PalActivityPage>
}
