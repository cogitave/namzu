import type { TenantId } from '../ids/index.js'

/**
 * Tenancy boundary for everything in the hierarchy.
 *
 * Intentionally thin — naming, billing, SSO, and quotas live outside the SDK
 * (session-hierarchy.md §4.1 Convention #17). No API surface crosses
 * {@link TenantId}.
 */
export interface Tenant {
	id: TenantId
	createdAt: Date
}
