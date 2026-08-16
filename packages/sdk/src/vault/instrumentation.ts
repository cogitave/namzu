import { buildProbeContext } from '../probe/context.js'
import { probe as defaultProbeRegistry } from '../probe/registry.js'
import type { ProbeObservation } from '../probe/registry.js'
import type { AuthConfig, CredentialRef, CredentialVault } from '../types/connector/index.js'
import type { ConnectorId, CredentialId, RunId, TenantId } from '../types/ids/index.js'
import type { CredentialProvider } from './CredentialProvider.js'

export interface VaultInstrumentationOptions {
	/** Observation only — a vault wrapper records, it never refuses. */
	readonly probes?: ProbeObservation
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

/**
 * Wrap a {@link CredentialProvider} so a change is observable.
 *
 * Through the SAME probe registry `vault_lookup` already uses. A second bus
 * would mean a subscriber that saw lookups and not rotations, or the other
 * way round, depending on which one it happened to find.
 *
 * `rotated` rather than `set` when a value was already there, and the
 * distinction is the one a reader actually wants: a first write is
 * configuration, a replacement is a credential turning over.
 */
export function wrapCredentialProviderWithProbes(
	provider: CredentialProvider,
	opts: VaultInstrumentationOptions & { readonly source?: string } = {},
): CredentialProvider {
	const probes = opts.probes ?? defaultProbeRegistry
	const source = opts.source ?? provider.constructor.name

	const announce = (kind: 'set' | 'unset' | 'rotated', ref: string): void => {
		probes.dispatch(
			{
				type: 'vault_credential_changed',
				kind,
				source,
				// The NAME, never the value. A change event exists to be logged,
				// forwarded and retained, which is exactly what a credential
				// must not be.
				ref,
				...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
				...(opts.runId ? { runId: opts.runId } : {}),
			},
			buildProbeContext(),
		)
	}

	return {
		resolve: (ref) => provider.resolve(ref),
		describe: (ref) => provider.describe(ref),

		async set(ref, value) {
			// Asked BEFORE the write, because afterwards every credential looks
			// like it was always there — and "configured for the first time"
			// and "rotated" are the two facts this event exists to separate.
			const before = await provider.describe(ref)
			await provider.set(ref, value)
			// Emitted only on success. A write that threw changed nothing, and
			// an event for it would have a reader chasing a rotation that
			// never happened.
			announce(before.configured ? 'rotated' : 'set', ref)
		},

		async unset(ref) {
			await provider.unset(ref)
			announce('unset', ref)
		},
	}
}
