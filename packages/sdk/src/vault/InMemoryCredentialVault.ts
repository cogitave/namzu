import { NAMZU } from '../constants/telemetry/index.js'
import type { AuthConfig, CredentialRef, CredentialVault } from '../types/connector/index.js'
import type { ConnectorId, CredentialId, TenantId } from '../types/ids/index.js'
import { generateCredentialId } from '../utils/id.js'
import type { LogAttributes } from '../utils/log/index.js'
import { SCOPE_ATTRIBUTE } from '../utils/log/types.js'
import { type Logger, getRootLogger } from '../utils/logger.js'

export class InMemoryCredentialVault implements CredentialVault {
	private refs: Map<CredentialId, CredentialRef> = new Map()
	private secrets: Map<CredentialId, AuthConfig> = new Map()
	private log: Logger

	constructor() {
		this.log = getRootLogger().child({ [SCOPE_ATTRIBUTE]: 'vault' })
	}

	async store(
		tenantId: TenantId,
		connectorId: ConnectorId,
		label: string,
		auth: AuthConfig,
	): Promise<CredentialRef> {
		const id = generateCredentialId()
		const ref: CredentialRef = {
			id,
			connectorId,
			tenantId,
			label,
			authType: auth.type,
			createdAt: Date.now(),
		}

		this.refs.set(id, ref)
		this.secrets.set(id, auth)
		const storedAttributes: LogAttributes = {
			[NAMZU.CREDENTIAL_ID]: id,
			[NAMZU.CREDENTIAL_LABEL]: label,
			[NAMZU.TENANT_ID]: tenantId,
		}
		this.log.info('Credential stored', storedAttributes)
		return ref
	}

	async retrieve(credentialId: CredentialId): Promise<AuthConfig | undefined> {
		return this.secrets.get(credentialId)
	}

	async revoke(credentialId: CredentialId): Promise<boolean> {
		const existed = this.refs.has(credentialId)
		this.refs.delete(credentialId)
		this.secrets.delete(credentialId)
		if (existed) {
			const revokedAttributes: LogAttributes = {
				[NAMZU.CREDENTIAL_ID]: credentialId,
			}
			this.log.info('Credential revoked', revokedAttributes)
		}
		return existed
	}

	async list(tenantId: TenantId, connectorId?: ConnectorId): Promise<CredentialRef[]> {
		const results: CredentialRef[] = []
		for (const ref of this.refs.values()) {
			if (ref.tenantId !== tenantId) continue
			if (connectorId && ref.connectorId !== connectorId) continue
			results.push(ref)
		}
		return results
	}
}
