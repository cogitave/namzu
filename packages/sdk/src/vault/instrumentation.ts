import { buildProbeContext } from '../probe/context.js'
import { type ProbeRegistry, probe as defaultProbeRegistry } from '../probe/registry.js'
import type { AuthConfig, CredentialRef, CredentialVault } from '../types/connector/index.js'
import type { ConnectorId, CredentialId, RunId, TenantId } from '../types/ids/index.js'

export interface VaultInstrumentationOptions {
	readonly probes?: ProbeRegistry
	readonly runId?: RunId
	readonly vaultId?: string
	readonly tenantId?: TenantId
}

export function wrapVaultWithProbes(
	vault: CredentialVault,
	opts: VaultInstrumentationOptions = {},
): CredentialVault {
	const probes = opts.probes ?? defaultProbeRegistry
	const runId = opts.runId
	const vaultId = opts.vaultId ?? vault.constructor.name
	const tenantIdHint = opts.tenantId

	return {
		store(
			tenantId: TenantId,
			connectorId: ConnectorId,
			label: string,
			auth: AuthConfig,
		): Promise<CredentialRef> {
			return vault.store(tenantId, connectorId, label, auth)
		},

		async retrieve(credentialId: CredentialId): Promise<AuthConfig | undefined> {
			const result = await vault.retrieve(credentialId)
			probes.dispatch(
				{
					type: 'vault_lookup',
					vaultId,
					credentialId,
					tenantId: tenantIdHint,
					found: result !== undefined,
					runId,
				},
				buildProbeContext({ runId }),
			)
			return result
		},

		revoke(credentialId: CredentialId): Promise<boolean> {
			return vault.revoke(credentialId)
		},

		list(tenantId: TenantId, connectorId?: ConnectorId): Promise<CredentialRef[]> {
			return vault.list(tenantId, connectorId)
		},
	}
}
