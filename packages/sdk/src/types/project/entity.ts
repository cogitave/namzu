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
 * Long-lived goal scope that owns shared memory, vaults, knowledge bases,
 * and deliverables across sessions. See session-hierarchy.md §4.2.
 */
export interface Project {
	id: ProjectId
	tenantId: TenantId
	name: string
	config: ProjectConfig
	createdAt: Date
	updatedAt: Date
}
