import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

/**
 * Built-in vault probe is intentionally `skipped`.
 *
 * `CredentialVault` is an interface, not a globally-discoverable
 * registry — consumers instantiate their own (`InMemoryCredentialVault`,
 * file-backed, env-backed, KMS-backed, …). The doctor cannot enumerate
 * vaults it doesn't know about. To get a real vault healthcheck, the
 * consumer registers a custom check via `registerDoctorCheck` that
 * exercises their specific vault wiring.
 *
 * `skipped`, not `inconclusive`, and the difference is the whole point of the
 * split: `inconclusive` means a check tried and could not answer, which is a
 * gap in the report and now carries a non-zero exit code. This check has no
 * subject to answer about — there is no discovery mechanism to fail — and that
 * is true on every machine, permanently, by design. Reporting a permanent
 * design decision as an unanswered question would make `namzu doctor` non-zero
 * on every healthy machine, and a diagnostic that always complains is one
 * nobody reads.
 */
export const vaultRegisteredCheck: DoctorCheck = {
	id: 'vault.registered',
	category: 'vault',
	run: async (): Promise<DoctorCheckResult> => ({
		status: 'skipped',
		message:
			'no vault auto-discovery in v1; register a vault check via registerDoctorCheck for your specific vault setup',
	}),
}
