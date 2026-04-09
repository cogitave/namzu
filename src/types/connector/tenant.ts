import type { CredentialId, EnvironmentId, TenantId } from '../ids/index.js'
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
	id: CredentialId
	connectorId: string
	tenantId: TenantId
	label: string
	authType: AuthType
	createdAt: number
	expiresAt?: number
}

export interface CredentialVault {
	store(
		tenantId: TenantId,
		connectorId: string,
		label: string,
		auth: AuthConfig,
	): Promise<CredentialRef>
	retrieve(credentialId: CredentialId): Promise<AuthConfig | undefined>
	revoke(credentialId: CredentialId): Promise<boolean>
	list(tenantId: TenantId, connectorId?: string): Promise<CredentialRef[]>
}
