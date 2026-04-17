/**
 * ArchiveBackend — pluggable archival contract. See session-hierarchy.md
 * §12.3 Retention and Archival.
 *
 * Convention #10 (Provider abstraction): interface lives here; concrete
 * implementations (disk, s3, glacier, …) live in sibling files. Phase 8 ships
 * the reference disk impl (`disk-backend.ts`); production deployments plug
 * their own over the same surface.
 *
 * Convention #9 (Registry + Manager + Store): {@link ArchivalManager} is the
 * Manager; this `ArchiveBackend` is the Provider slot it drives; the live
 * `SessionStore` is the Store it mutates.
 */

import type { SessionMessage } from '../../store/session/messages.js'
import type { SessionId, SubSessionId, TenantId } from '../../types/ids/index.js'
import type { SummaryId } from '../../types/session/ids.js'
import type { SessionSummaryRef } from '../summary/ref.js'
import type { WorkspaceRef } from '../workspace/ref.js'
import type { ArchiveBackendRef } from './archive-backend-ref.js'

/**
 * Output of a successful {@link ArchiveBackend.store} call. `archiveRef` is
 * the opaque lookup key used by {@link ArchiveBackend.restore} to rehydrate
 * the bundle.
 */
export interface ArchiveOutput {
	readonly archiveRef: ArchiveBackendRef
	readonly archivedAt: Date
}

/**
 * Bundle handed to {@link ArchiveBackend.store} (and returned by
 * {@link ArchiveBackend.restore}). Captures the minimum surface needed to
 * re-hydrate a sub-session in the future — sub-session metadata plus the
 * owning session's messages and optional summary.
 */
export interface ArchiveInput {
	readonly subSessionId: SubSessionId
	/**
	 * The session the sub-session owns. Each sub-session wraps exactly one
	 * child {@link Session} (pattern doc §4.4); the archived bundle captures
	 * that session's messages and summary.
	 */
	readonly sessionId: SessionId
	readonly tenantId: TenantId
	/**
	 * Present when the sub-session had a provisioned workspace at archive
	 * time. Absent for sub-sessions that never materialized one (pattern doc
	 * §7.1 allows lazy workspace provisioning).
	 */
	readonly workspace?: WorkspaceRef
	readonly summaryRef?: SessionSummaryRef
	/**
	 * Full message log for the owning session. Captured at archive time;
	 * append-only discipline (pattern doc §13.4) means this is a complete
	 * snapshot, not a partial view.
	 */
	readonly messages: readonly SessionMessage[]
}

/**
 * Pluggable archival backend. Implementations MUST write atomically
 * (Convention #8 — write-tmp-rename per file) and MUST produce a unique
 * {@link ArchiveBackendRef} per call. Concurrent `store` calls with
 * overlapping input are a caller error — the Manager serializes per
 * sub-session.
 */
export interface ArchiveBackend {
	/** Discriminator. Free-form; reference impl uses `'disk'`. */
	readonly kind: string

	/**
	 * Persist the bundle. Returns the lookup ref consumers embed in the
	 * sub-session tombstone (§12.3). Must be atomic at the bundle level —
	 * post-success, a restore sees the full bundle or throws.
	 */
	store(input: ArchiveInput): Promise<ArchiveOutput>

	/**
	 * Reverse of {@link store}. Throws when the ref does not resolve or when
	 * the bundle is corrupt. Does NOT re-materialize the workspace on disk —
	 * callers decide whether to re-provision via a
	 * {@link WorkspaceBackendDriver}.
	 */
	restore(archiveRef: ArchiveBackendRef): Promise<ArchiveInput>
}

/**
 * The in-store marker a sub-session becomes after archival. Replaces the
 * live record in-slot (see pattern doc §12.3): the sub-session's status
 * flips to `'archived'` and `archiveRef` + `archivedAt` are attached. This
 * way `SessionStore.drill` still finds it via the normal linkage path — the
 * tombstone is navigable without a parallel index.
 *
 * Fields are a subset of {@link SubSession} — the identity columns plus the
 * archive pointer — extracted here so consumers can destructure a tombstone
 * view without carrying the full live-record shape.
 */
export interface SubSessionTombstone {
	readonly subSessionId: SubSessionId
	readonly sessionId: SessionId
	readonly tenantId: TenantId
	readonly summaryRef?: SummaryId
	readonly archiveRef: ArchiveBackendRef
	readonly archivedAt: Date
}
