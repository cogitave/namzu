/**
 * WorkspaceRef + backend metadata.
 *
 * See session-hierarchy.md §4.9 (WorkspaceRef) and §7 (Workspace and
 * Worktree). The `meta` field is a discriminated union on `backend` — Phase 3
 * ships the `git-worktree` variant; `tmpfs`, `container`, and `shared` land
 * in a later phase of the overall roadmap (post-MVP) without breaking
 * existing consumers (Convention #6).
 */

import type { WorkspaceId } from '../../types/session/ids.js'

/**
 * Supported backend kinds. Additional variants are append-only; existing
 * consumers switch with an `_exhaustive` never-guard and will fail to compile
 * when the union grows — paired with the update at the discriminated
 * {@link WorkspaceBackendMeta} site (Convention #6).
 */
export type WorkspaceBackendKind = 'git-worktree' | 'tmpfs' | 'container' | 'shared'

/**
 * Git-worktree backend metadata. Matches session-hierarchy.md §4.9 /§7.2.
 */
export interface GitWorktreeBackendMeta {
	backend: 'git-worktree'
	/** Absolute path to the canonical repo (`.git` directory). */
	repoRoot: string
	/** Branch / ref the worktree tracks. */
	branch: string
	/** Absolute path to the worktree directory. */
	worktreePath: string
}

/**
 * Discriminated union of backend-specific metadata. Only `git-worktree` is
 * populated in Phase 3. Future variants (tmpfs, container, shared) must be
 * added here and to every exhaustive consumer.
 */
export type WorkspaceBackendMeta = GitWorktreeBackendMeta

/**
 * Persisted ref to a provisioned workspace. Every {@link Session} with a
 * running Run persists a {@link WorkspaceRef} so recovery after process
 * restart is possible (session-hierarchy.md §7.1).
 */
export interface WorkspaceRef {
	id: WorkspaceId
	meta: WorkspaceBackendMeta
	createdAt: Date
}
