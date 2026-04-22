import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

/**
 * Built-in vault probe is intentionally inconclusive.
 *
 * `CredentialVault` is an interface, not a globally-discoverable
 * registry — consumers instantiate their own (`InMemoryCredentialVault`,
 * file-backed, env-backed, KMS-backed, …). The doctor cannot enumerate
 * vaults it doesn't know about. To get a real vault healthcheck, the
 * consumer registers a custom check via `registerDoctorCheck` that
 * exercises their specific vault wiring.
 */
export const vaultRegisteredCheck: DoctorCheck = {
	id: 'vault.registered',
	category: 'vault',
	run: async (): Promise<DoctorCheckResult> => ({
		status: 'inconclusive',
		message:
			'no vault auto-discovery in v1; register a vault check via registerDoctorCheck for your specific vault setup',
	}),
}
