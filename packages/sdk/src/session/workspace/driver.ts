/**
 * WorkspaceBackendDriver — pluggable backend contract for workspace
 * provisioning. See session-hierarchy.md §7.1.
 *
 * Every Session persists a {@link WorkspaceRef}; the driver owns the
 * underlying filesystem/container/etc. semantics. Phase 3 ships the
 * git-worktree reference implementation (`git-worktree.ts`); tmpfs,
 * container, and shared variants slot behind this same interface in a
 * later phase (Convention #10: provider abstraction).
 */

import type { WorkspaceBackendKind, WorkspaceRef } from '../../types/workspace/ref.js'

/**
 * Params for {@link WorkspaceBackendDriver.create}. `baseRef` selects the
 * commit / branch the workspace should track; when absent the driver
 * provisions from the backend's default (e.g. the current branch of the
 * repo for git-worktree).
 */
export interface CreateWorkspaceParams {
	baseRef?: string
	/**
	 * Traceable name below the configured workspace root. Nested names are
	 * accepted; absolute paths, traversal, and paths rewritten by a filesystem
	 * link are refused by the Git driver.
	 */
	label?: string
}

/**
 * Params for {@link WorkspaceBackendDriver.branch}. `label` is a traceable tag
 * embedded into the new workspace name so operators can identify provenance
 * without reaching into the driver's internal naming scheme. Backend path and
 * identifier constraints still apply.
 */
export interface BranchWorkspaceParams {
	label?: string
}

/**
 * Snapshot returned by {@link WorkspaceBackendDriver.inspect}. `exists` is
 * `false` when the underlying resource has been disposed out-of-band (e.g.
 * manual `git worktree remove` on disk); consumers can use it to detect
 * divergence between the persisted {@link WorkspaceRef} and the backend.
 */
export interface WorkspaceInspection {
	exists: boolean
	currentRef: string
	isDirty: boolean
	/**
	 * Whether the workspace moved off the commit it started on. Absent when the
	 * backend cannot tell; a caller deciding whether to keep it treats absent
	 * as `true`.
	 */
	hasNewCommits?: boolean
}

/**
 * Backend driver contract. All methods are async and may throw
 * {@link WorkspaceBackendError} on I/O failures. `dispose` is idempotent —
 * calling it against an already-disposed ref is not an error (mitigates
 * roadmap Risk #3: broadcast rollback must not fail on partial state). A ref
 * remains affiliated with the driver configuration that created it; drivers
 * refuse foreign backend, repository, or ownership-root metadata.
 */
export interface WorkspaceBackendDriver {
	readonly kind: WorkspaceBackendKind
	create(params: CreateWorkspaceParams): Promise<WorkspaceRef>
	branch(source: WorkspaceRef, params: BranchWorkspaceParams): Promise<WorkspaceRef>
	dispose(ref: WorkspaceRef): Promise<void>
	inspect(ref: WorkspaceRef): Promise<WorkspaceInspection>
	/**
	 * The child that worked in `ref` has ended: let go of whatever claim this
	 * driver still makes on that checkout, whether or not the checkout is kept.
	 *
	 * A checkout provisioned with `retain`, or with `retain-changed` when the
	 * child left something behind, is never passed to {@link dispose}, so without
	 * this the backend would go on reporting a checkout as in use by a session
	 * that has already finished. A driver that claims nothing can leave it out.
	 *
	 * Called on every terminal path of a child, before the retention decision.
	 */
	release?(ref: WorkspaceRef): Promise<void>
}

export type { WorkspaceBackendKind } from '../../types/workspace/ref.js'
