/**
 * DeliverableRef — discriminated union of artifact types a completed
 * sub-session may emit.
 *
 * Consumed by two surfaces:
 *   1. `SessionSummaryRef.deliverables` — authoritative list of artifacts a
 *      completed sub-session produced. See session-hierarchy.md §4.7.
 *   2. `SubSession.prevArtifactRef` — intervention chains reference a prior
 *      immutable artifact. See session-hierarchy.md §4.5, §8.1.
 *
 * The `session_summary` variant is what intervention sub-sessions use — a
 * follow-up intervention points at the previous completed session's summary,
 * forming a strict acyclic DAG validated by
 * `session/intervention/prev-artifact.ts`.
 *
 * Convention #6: this is a discriminated union on `kind`; any consumer must
 * handle all variants exhaustively.
 */

import type { RunId, SessionId } from '../ids/index.js'
import type { DeliverableId, SummaryId } from '../session/ids.js'

/** Discriminator for {@link DeliverableRef}. */
export type DeliverableKind = 'file' | 'session_summary' | 'message' | 'artifact_blob'

/**
 * A file deliverable — a path relative to the workspace root, plus a content
 * hash pinning the file to its state at materialize time. Subsequent edits to
 * the file on disk do not mutate the deliverable; the ref is a snapshot.
 */
export interface FileDeliverable {
	readonly id: DeliverableId
	readonly kind: 'file'
	/** Path relative to the owning session's workspace root. */
	readonly path: string
	/** sha256 of the file's content at materialize time. */
	readonly contentHash: string
	readonly sizeBytes: number
}

/**
 * A pointer to a previously-materialized {@link SessionSummaryRef}. The
 * intervention DAG uses this variant to reference the immutable output of a
 * prior completed session.
 */
export interface SessionSummaryDeliverable {
	readonly id: DeliverableId
	readonly kind: 'session_summary'
	readonly sessionId: SessionId
	readonly summaryRef: SummaryId
	readonly at: Date
}

/**
 * A specific persisted message within a session run — useful for referencing
 * a single LLM turn as an artifact (e.g. a decision record).
 */
export interface MessageDeliverable {
	readonly id: DeliverableId
	readonly kind: 'message'
	readonly sessionId: SessionId
	readonly runId: RunId
	/** Opaque identifier bound to the run's persisted message log. */
	readonly messageId: string
}

/**
 * An opaque blob deliverable — content lives in an out-of-band storage
 * backend (object store, artifact registry). The SDK does not fetch or
 * validate blob contents; callers resolve via the `storageRef`.
 */
export interface ArtifactBlobDeliverable {
	readonly id: DeliverableId
	readonly kind: 'artifact_blob'
	/** Opaque — bound to a storage backend the consumer owns. */
	readonly storageRef: string
	readonly mediaType?: string
}

export type DeliverableRef =
	| FileDeliverable
	| SessionSummaryDeliverable
	| MessageDeliverable
	| ArtifactBlobDeliverable
