/**
 * ArchivalManager — on-demand archival primitive for sub-sessions. Pattern
 * doc §12.3 (Retention and Archival).
 *
 * Convention #9 (Registry + Manager + Store): Manager-shape with explicit
 * deps for the {@link SessionStore}, {@link WorkspaceBackendRegistry}, and a
 * pluggable {@link ArchiveBackend}. Convention #5 deny-by-default: absent
 * backend → {@link ArchiveNotConfiguredError} on every `archive()` call.
 *
 * Atomic invariant (pattern doc §12.3):
 *
 *   1. Read sub-session + owning session + messages + optional summary
 *   2. backend.store(bundle) — archive durability confirmed
 *   3. Flip sub-session to `status: 'archived'` + attach archiveRef/archivedAt
 *   4. Workspace driver dispose (idempotent)
 *
 * Step 2 is the durability boundary: if the process crashes between step 2
 * and step 3, the archive exists but the live record is still non-archived
 * — recovery is to re-invoke `archive()`, which sees a non-terminal status
 * and replays. Step 3 is the single point of no return.
 *
 * A completed archive leaves the sub-session in-place with `status:
 * 'archived'` + an attached `archiveRef`. Pattern doc §12.3 calls this the
 * tombstone: `SessionStore.drill` still finds it through the normal linkage
 * path, so the archive is navigable without a parallel index.
 */

import type { SessionId, SubSessionId, TenantId } from '../../types/ids/index.js'
import type { WorkspaceId } from '../../types/session/ids.js'
import type { SessionStore } from '../../types/session/store.js'
import type { SubSession, SubSessionStatus } from '../hierarchy/sub-session.js'
import type { WorkspaceRef } from '../workspace/ref.js'
import type { WorkspaceBackendRegistry } from '../workspace/registry.js'
import type { ArchiveBackend, SubSessionTombstone } from './backend.js'

/**
 * Raised when {@link ArchivalManager.archive} or {@link ArchivalManager.restore}
 * is invoked against a project whose retention policy does not supply an
 * {@link ArchiveBackend}. Convention #5 — explicit error rather than silent
 * no-op.
 */
export class ArchiveNotConfiguredError extends Error {
	constructor() {
		super('Retention archival not configured for this project (Convention #5: deny-by-default)')
		this.name = 'ArchiveNotConfiguredError'
	}
}

/**
 * Raised when {@link ArchivalManager.archive} targets a sub-session that is
 * not eligible for archival. The three reasons map to pattern doc §12.3
 * (archival only applies to idle / merged / rejected / failed sub-sessions).
 */
export class SubSessionNotArchivableError extends Error {
	readonly details: {
		readonly subSessionId: SubSessionId
		readonly reason: 'not_idle' | 'already_archived' | 'missing'
	}

	constructor(details: {
		subSessionId: SubSessionId
		reason: 'not_idle' | 'already_archived' | 'missing'
	}) {
		super(`Sub-session ${details.subSessionId} not archivable: ${details.reason}`)
		this.name = 'SubSessionNotArchivableError'
		this.details = details
	}
}

/**
 * Raised when {@link ArchivalManager.restore} is called against a
 * sub-session that is not currently archived. Distinct from
 * {@link SubSessionNotArchivableError} because the semantics are inverted:
 * restore requires an archived record, archive rejects one.
 */
export class SubSessionNotArchivedError extends Error {
	readonly details: {
		readonly subSessionId: SubSessionId
		readonly reason: 'not_archived' | 'missing' | 'missing_archive_ref'
	}

	constructor(details: {
		subSessionId: SubSessionId
		reason: 'not_archived' | 'missing' | 'missing_archive_ref'
	}) {
		super(`Sub-session ${details.subSessionId} cannot be restored: ${details.reason}`)
		this.name = 'SubSessionNotArchivedError'
		this.details = details
	}
}

/**
 * Lookup callback resolving a live {@link WorkspaceRef} from the id stored
 * on a {@link SubSession}. Injected by the caller because Phase 8 does not
 * ship a dedicated workspace store — the ref typically lives in a handoff
 * assignment or is held by the agent lifecycle manager. Return `null` when
 * the ref is unknown or already disposed; the manager archives without
 * workspace data in that case (the disk backend allows it).
 */
export type WorkspaceResolver = (
	workspaceId: WorkspaceId,
	tenantId: TenantId,
) => Promise<WorkspaceRef | null>

/**
 * Sub-session statuses eligible for archival. Pattern doc §12.3 speaks of
 * "idle" broadly; we honor the enumerated terminal-like states. Anything
 * else (active / pending / in-flight merge) rejects with
 * `'not_idle'`.
 */
const ARCHIVABLE_STATUSES: ReadonlySet<SubSessionStatus> = new Set([
	'idle',
	'merged',
	'merge_rejected',
	'failed',
])

export interface ArchivalManagerDeps {
	readonly sessionStore: SessionStore
	readonly workspaceRegistry: WorkspaceBackendRegistry
	/**
	 * Archive backend. Absent = archival disabled for this manager
	 * (`archive()`/`restore()` throw {@link ArchiveNotConfiguredError}).
	 */
	readonly archiveBackend?: ArchiveBackend
	/**
	 * Optional workspace resolver. When absent, `archive()` skips workspace
	 * snapshotting (only the ref would be captured) and workspace disposal
	 * (nothing to dispose). This is the conservative default and matches
	 * pattern doc §7.1 (lazy workspace provisioning).
	 */
	readonly workspaceResolver?: WorkspaceResolver
	/**
	 * Optional logger hook for `sub_session.archived` emission. Pattern doc
	 * §12.3 requires the event; full event-bus wiring is a platform concern
	 * (a later phase of the roadmap). Phase 8 ships the log seam so tests
	 * can observe without the bus.
	 */
	readonly onArchived?: (tombstone: SubSessionTombstone) => void
	readonly onRestored?: (subSessionId: SubSessionId, tenantId: TenantId) => void
}

export class ArchivalManager {
	private readonly deps: ArchivalManagerDeps

	constructor(deps: ArchivalManagerDeps) {
		this.deps = deps
	}

	/**
	 * Archive an eligible sub-session. See module header for the atomic
	 * invariant and recovery semantics.
	 *
	 * Returns the {@link SubSessionTombstone} shape — the same identity +
	 * archive fields the store now carries on the live record.
	 */
	async archive(subSessionId: SubSessionId, tenantId: TenantId): Promise<SubSessionTombstone> {
		const backend = this.requireBackend()

		// 1. Resolve + validate sub-session.
		const sub = await this.deps.sessionStore.getSubSession(subSessionId, tenantId)
		if (!sub) {
			throw new SubSessionNotArchivableError({ subSessionId, reason: 'missing' })
		}
		if (sub.status === 'archived') {
			throw new SubSessionNotArchivableError({ subSessionId, reason: 'already_archived' })
		}
		if (!ARCHIVABLE_STATUSES.has(sub.status)) {
			throw new SubSessionNotArchivableError({ subSessionId, reason: 'not_idle' })
		}

		// 2. Load owning child session bundle (messages + optional summary).
		// Phase 9 Known Delta #7: uses `loadSessionMessages` for full-fidelity
		// round-trip (original MessageId + timestamp preserved). Previously
		// the Phase 8 archivalmanager synthesized `msg_restored_N` IDs from the
		// payload-only `loadMessages` return — that lossy reshape is gone.
		const childSessionId: SessionId = sub.childSessionId
		const messages = await this.deps.sessionStore.loadSessionMessages(childSessionId, tenantId)

		const summaryRefOrNull = await this.deps.sessionStore.getSummary(childSessionId, tenantId)
		const summaryRef = summaryRefOrNull ?? undefined

		// 3. Resolve optional live workspace ref.
		let workspace: WorkspaceRef | undefined
		if (sub.workspaceId && this.deps.workspaceResolver) {
			const resolved = await this.deps.workspaceResolver(sub.workspaceId, tenantId)
			if (resolved) workspace = resolved
		}

		// 4. Durability boundary: persist the archive bundle.
		const bundleOut = await backend.store({
			subSessionId: sub.id,
			sessionId: childSessionId,
			tenantId,
			...(workspace !== undefined && { workspace }),
			...(summaryRef !== undefined && { summaryRef }),
			messages,
		})

		// 5. Point-of-no-return: flip sub-session to archived + attach ref.
		const archived: SubSession = {
			...sub,
			status: 'archived',
			archiveRef: bundleOut.archiveRef,
			archivedAt: bundleOut.archivedAt,
		}
		await this.deps.sessionStore.updateSubSession(archived, tenantId)

		// 6. Dispose the workspace (idempotent — driver contract tolerates
		//    already-disposed refs; a missing ref is a no-op).
		if (workspace) {
			try {
				const driver = this.deps.workspaceRegistry.get(workspace.meta.backend)
				await driver.dispose(workspace)
			} catch {
				// Idempotent — a secondary failure here must not unwind the
				// already-committed archive. Pattern doc §12.3: workspace
				// disposal is a cleanup operation, not part of the atomic
				// archive envelope.
			}
		}

		const tombstone: SubSessionTombstone = {
			subSessionId: sub.id,
			sessionId: childSessionId,
			tenantId,
			...(sub.summaryRef !== undefined && { summaryRef: sub.summaryRef }),
			archiveRef: bundleOut.archiveRef,
			archivedAt: bundleOut.archivedAt,
		}

		this.deps.onArchived?.(tombstone)
		return tombstone
	}

	/**
	 * Reverse of {@link archive}. Reads the tombstone, invokes
	 * `backend.restore`, then flips the sub-session back to `idle`. Does NOT
	 * re-materialize the workspace — the caller decides whether to
	 * re-provision via a {@link WorkspaceBackendDriver}.
	 *
	 * The restored `ArchiveInput` bundle is NOT returned here because the
	 * concrete pattern in Phase 8 is "flip status and make navigable again";
	 * consumers that need the bundle itself can call the backend directly.
	 */
	async restore(subSessionId: SubSessionId, tenantId: TenantId): Promise<void> {
		const backend = this.requireBackend()

		const sub = await this.deps.sessionStore.getSubSession(subSessionId, tenantId)
		if (!sub) {
			throw new SubSessionNotArchivedError({ subSessionId, reason: 'missing' })
		}
		if (sub.status !== 'archived') {
			throw new SubSessionNotArchivedError({ subSessionId, reason: 'not_archived' })
		}
		if (!sub.archiveRef) {
			throw new SubSessionNotArchivedError({ subSessionId, reason: 'missing_archive_ref' })
		}

		// Validate the archive ref by invoking the backend — this surfaces
		// ArchiveNotFoundError up the stack if the bundle is missing or
		// corrupt, rather than silently un-archiving an orphaned record.
		await backend.restore(sub.archiveRef)

		const restored: SubSession = {
			...sub,
			status: 'idle',
			archiveRef: undefined,
			archivedAt: undefined,
		}
		await this.deps.sessionStore.updateSubSession(restored, tenantId)

		this.deps.onRestored?.(subSessionId, tenantId)
	}

	private requireBackend(): ArchiveBackend {
		const backend = this.deps.archiveBackend
		if (!backend) throw new ArchiveNotConfiguredError()
		return backend
	}
}
