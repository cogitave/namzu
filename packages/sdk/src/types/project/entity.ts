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
 * Whether the workspace accepts new work.
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
 * project is the thing a tenant actually closes — a workspace with its own
 * limits, its own environment, and its own memory — and closing it has to mean
 * something to the code, not only to a listing.
 */
export interface Project {
	id: ProjectId
	tenantId: TenantId
	name: string
	config: ProjectConfig
	status: ProjectStatus
	/** CAS counter for status transitions. Mirrors `Session.ownerVersion`. */
	ownerVersion: number
	createdAt: Date
	updatedAt: Date
}
