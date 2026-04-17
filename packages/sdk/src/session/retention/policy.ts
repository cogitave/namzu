/**
 * RetentionPolicy — per-project configuration for sub-session retention and
 * archival. See session-hierarchy.md §12.3.
 *
 * Deny-by-default (Convention #5): the absence of any field means "no
 * automatic archival." A policy without an `archiveBackend` cannot drive
 * archival at all — {@link ArchivalManager.archive} rejects with
 * {@link ArchiveNotConfiguredError}. The primitive Phase 8 ships is
 * on-demand `archive(subSessionId)`; a scheduler that invokes the primitive
 * is platform-layer (out of SDK scope per the roadmap "What's OUT" list).
 *
 * Phase 8 replaces the Phase 1 `RetentionPolicyRef = unknown` placeholder at
 * `session/hierarchy/project.ts` with this real type.
 */

import type { ArchiveBackendRef } from './archive-backend-ref.js'

/**
 * Retention policy. Every field is optional (deny-by-default): no policy, no
 * archival. See pattern doc §12.3 for rationale.
 */
export interface RetentionPolicy {
	/**
	 * Idle sub-sessions older than this are eligible for archival. Expressed in
	 * milliseconds to stay dependency-free — no `Duration` type in the kernel
	 * today. Absent field = no TTL (eligibility never triggers on age alone).
	 */
	readonly idleSubSessionTTL?: number

	/**
	 * Hard cap on sub-sessions per project. When exceeded, the oldest-idle
	 * sub-sessions become archival-eligible. Absent = no cap.
	 *
	 * Note: enforcement of this cap is platform-layer (scheduler territory).
	 * The SDK primitive `archive()` takes an explicit {@link SubSessionId} —
	 * it does not walk the project tree.
	 */
	readonly maxSubSessionsPerProject?: number

	/**
	 * Ref for the backing {@link ArchiveBackend}. Absent = archival disabled
	 * even if TTL/cap are set — {@link ArchivalManager.archive} rejects with
	 * {@link ArchiveNotConfiguredError}. This is the deny-by-default gate.
	 */
	readonly archiveBackend?: ArchiveBackendRef
}

/**
 * The empty retention policy — archival fully disabled. Exported as a named
 * constant so call sites declare their deny-by-default posture explicitly
 * rather than relying on `{}` literals (Convention #0, #5).
 */
export const RETENTION_POLICY_DISABLED: RetentionPolicy = Object.freeze({})
