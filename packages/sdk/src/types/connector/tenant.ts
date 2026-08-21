import type { ConnectorId, CredentialId, EnvironmentId, TenantId } from '../ids/index.js'
import type { AuthConfig, AuthType } from './core.js'

export type EnvironmentTier = 'production' | 'staging' | 'development' | 'testing'

export interface EnvironmentDescriptor {
	id: EnvironmentId
	name: string
	tier: EnvironmentTier
	orgId?: string
	metadata?: Record<string, unknown>
}

export interface TenantDescriptor {
	id: TenantId
	name: string
	metadata?: Record<string, unknown>
}

export interface TenantRateLimitConfig {
	maxRequests: number

	windowMs: number
}

export interface CredentialRef {
	readonly id: CredentialId
	readonly connectorId: ConnectorId
	readonly tenantId: TenantId
	readonly label: string
	readonly authType: AuthType
	readonly createdAt: number
	readonly expiresAt?: number
}

export interface CredentialVault {
	store(
		tenantId: TenantId,
		connectorId: ConnectorId,
		label: string,
		auth: AuthConfig,
	): Promise<CredentialRef>
	/** Host-authority lookup. Tenant-facing code must use {@link retrieveForScope}. */
	retrieve(credentialId: CredentialId): Promise<AuthConfig | undefined>
	/**
	 * Resolve only when the credential atomically belongs to both authorities.
	 * Implementations must not perform an unscoped read followed by a separate
	 * metadata check: a concurrent rotation must not cross the scope boundary.
	 */
	retrieveForScope(
		tenantId: TenantId,
		connectorId: ConnectorId,
		credentialId: CredentialId,
	): Promise<AuthConfig | undefined>
	/** Host-authority deletion. Tenant-facing code must use {@link revokeForTenant}. */
	revoke(credentialId: CredentialId): Promise<boolean>
	/** Atomically delete only when the credential belongs to `tenantId`. */
	revokeForTenant(tenantId: TenantId, credentialId: CredentialId): Promise<boolean>
	list(tenantId: TenantId, connectorId?: ConnectorId): Promise<CredentialRef[]>
}
