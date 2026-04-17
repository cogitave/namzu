import type { KnowledgeBaseRef, MemoryStoreRef, TenantId, VaultRef } from '../../types/ids/index.js'
import type { ProjectId } from '../../types/session/ids.js'

/**
 * Placeholder ref for {@link ProjectConfig.retentionPolicy}. The full
 * {@link RetentionPolicy} shape lands in Phase 8 (session-hierarchy.md
 * §12.3); kept as `unknown` here so Phase 1 stays type-only with no
 * behavioural dependencies.
 */
export type RetentionPolicyRef = unknown

/**
 * Per-project configuration. Defaults per session-hierarchy.md §3 / §4.2 /
 * §8.2 are applied at instantiation time (not encoded here) so the type
 * stays declarative:
 *   - maxDelegationDepth: 4
 *   - maxDelegationWidth: 8
 *   - maxInterventionDepth: 10
 *   - sharedDeliverables: false
 */
export interface ProjectConfig {
	maxDelegationDepth: number
	maxDelegationWidth: number
	maxInterventionDepth: number
	sharedMemoryStores?: readonly MemoryStoreRef[]
	sharedVaults?: readonly VaultRef[]
	sharedKnowledgeBases?: readonly KnowledgeBaseRef[]
	sharedDeliverables?: boolean
	retentionPolicy?: RetentionPolicyRef
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
