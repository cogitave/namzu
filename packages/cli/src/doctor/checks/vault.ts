import type { CredentialProvider, DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

/**
 * What this machine can answer about its credentials.
 *
 * This check used to return `skipped` unconditionally, with the message
 * "no vault auto-discovery in v1" — an answer that was the same on every
 * machine, forever, which is the shape `a-check-that-cannot-fail` warns
 * about. It was honest about the world at the time: `CredentialVault` was
 * an interface nobody registered, so there was nothing to enumerate.
 *
 * There is now. The check reads what the registered providers report and
 * returns `skipped` only when NONE is registered — which is a real state a
 * host can be in, and now the only one that produces it.
 */

/** Providers this process knows about. Registered by whoever builds them. */
const registered: { provider: CredentialProvider; label: string; refs: readonly string[] }[] = []

export function registerCredentialProvider(
	provider: CredentialProvider,
	label: string,
	refs: readonly string[],
): () => void {
	const entry = { provider, label, refs }
	registered.push(entry)
	return () => {
		const i = registered.indexOf(entry)
		if (i >= 0) registered.splice(i, 1)
	}
}

/** For tests, and for a host rebuilding its wiring. */
export function clearRegisteredCredentialProviders(): void {
	registered.length = 0
}

export const vaultRegisteredCheck: DoctorCheck = {
	id: 'vault.registered',
	category: 'vault',
	run: async (): Promise<DoctorCheckResult> => {
		if (registered.length === 0) {
			// `skipped`, not `inconclusive`, and the difference is the whole
			// point of the split: `inconclusive` means a check tried and could
			// not answer, which is a gap in the report and carries a non-zero
			// exit. A host that registered no provider has no subject here,
			// and reporting that as an unanswered question would make
			// `namzu doctor` non-zero on a perfectly healthy machine.
			return {
				status: 'skipped',
				message: 'No credential provider is registered, so there is nothing to report on.',
			}
		}

		const lines: string[] = []
		let anyConfigured = false
		for (const entry of registered) {
			for (const ref of entry.refs) {
				// `describe`, never `resolve`. This runs in a diagnostic whose
				// output an operator pastes into an issue, and a check that
				// read the value to report on it would be the leak.
				const described = await entry.provider.describe(ref)
				if (described.configured) anyConfigured = true
				lines.push(
					`${entry.label}: ${ref} — ${described.configured ? 'configured' : 'not set'}${
						described.source ? ` (${described.source})` : ''
					}, ${described.writable ? 'writable' : 'read-only'}`,
				)
			}
		}

		return {
			// A provider registered and nothing configured is a real answer,
			// not a failure: an operator who has not logged in yet is in a
			// state the doctor should describe rather than complain about.
			status: anyConfigured ? 'pass' : 'warn',
			message: lines.join('\n'),
		}
	},
}
