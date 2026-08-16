import type { RetentionPolicy } from '../../types/retention/policy.js'
import type { KnowledgeBaseRef, MemoryStoreRef, TenantId, VaultRef } from '../ids/index.js'
import type { ProjectId } from '../session/ids.js'

/**
 * Per-project configuration. Defaults per session-hierarchy.md §3 / §4.2 /
 * §8.2 are applied at instantiation time (not encoded here) so the type
 * stays declarative:
 *   - maxDelegationDepth: 4
 *   - maxDelegationWidth: 8
 *   - maxInterventionDepth: 10
 *   - sharedDeliverables: false
 *
 * `retentionPolicy` replaces the Phase 1 `RetentionPolicyRef = unknown`
 * placeholder with the real {@link RetentionPolicy} shape (§12.3). Absent
 * (deny-by-default per Convention #5) means archival is fully disabled for
 * the project; explicit configuration is required.
 */
export interface ProjectConfig {
	maxDelegationDepth: number
	maxDelegationWidth: number
	maxInterventionDepth: number
	sharedMemoryStores?: readonly MemoryStoreRef[]
	sharedVaults?: readonly VaultRef[]
	sharedKnowledgeBases?: readonly KnowledgeBaseRef[]
	sharedDeliverables?: boolean
	retentionPolicy?: RetentionPolicy
}

/**
 * Whether the project accepts new work.
 *
 * Owner-managed, like the status it replaces: a project does not derive
 * `archived` from having no live sessions, because "empty right now" and
 * "closed" are different facts and only one of them is a decision.
 */
export type ProjectStatus = 'open' | 'archived'

/**
 * Long-lived goal scope that owns shared memory, vaults, knowledge bases,
 * and deliverables across sessions. See session-hierarchy.md §4.2.
 *
 * `status` is the gate the ingress paths read: an archived project accepts no
 * new session and no handoff. It lives here rather than on Thread because the
 * project is the thing a tenant actually closes — a scope with its own
 * limits, its own environment, and its own memory — and closing it has to mean
 * something to the code, not only to a listing.
 *
 * "Workspace" is a different noun in this codebase and is already taken:
 * see `WorkspaceRef`, which is per-run provisioning. This is the durable
 * one, and the prose above used to say the other word.
 */
export interface Project {
	id: ProjectId
	tenantId: TenantId
	name: string
	config: ProjectConfig
	status: ProjectStatus
	/** CAS counter for status transitions. Mirrors `Session.ownerVersion`. */
	ownerVersion: number
	/**
	 * The canonical directory this project's work happens in.
	 *
	 * Resolved through `realpath` at creation, so a symlink and a trailing
	 * slash and the real path are one project rather than three records for
	 * one directory.
	 *
	 * NOT `WorkspaceRef.meta.worktreePath`. That is per-RUN provisioning and
	 * may be a different directory entirely — a git worktree cut for one
	 * run and discarded after it. This is the durable binding a host uses to
	 * answer "which project is this directory", across sessions and across
	 * process restarts.
	 *
	 * Optional: a project need not be on disk at all.
	 */
	readonly rootPath?: string
	createdAt: Date
	updatedAt: Date
}
