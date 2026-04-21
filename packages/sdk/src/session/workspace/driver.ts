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
	label?: string
}

/**
 * Params for {@link WorkspaceBackendDriver.branch}. `label` is a free-form
 * tag embedded into the new workspace name so operators can trace provenance
 * without reaching into the driver's internal naming scheme.
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
}

/**
 * Backend driver contract. All methods are async and may throw
 * {@link WorkspaceBackendError} on I/O failures. `dispose` is idempotent —
 * calling it against an already-disposed ref is not an error (mitigates
 * roadmap Risk #3: broadcast rollback must not fail on partial state).
 */
export interface WorkspaceBackendDriver {
	readonly kind: WorkspaceBackendKind
	create(params: CreateWorkspaceParams): Promise<WorkspaceRef>
	branch(source: WorkspaceRef, params: BranchWorkspaceParams): Promise<WorkspaceRef>
	dispose(ref: WorkspaceRef): Promise<void>
	inspect(ref: WorkspaceRef): Promise<WorkspaceInspection>
}

export type { WorkspaceBackendKind } from '../../types/workspace/ref.js'
