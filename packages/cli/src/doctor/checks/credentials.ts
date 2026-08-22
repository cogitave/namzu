import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { discoverProviders } from '../../integrations/providers/discover.js'

/**
 * Which credential sources namzu actually scanned, and what each yielded.
 *
 * This check exists because a source was *removed*. namzu used to read the
 * secrets file of an external peer daemon it integrated with, and a user could
 * have a working namzu with no environment variable set anywhere. When that
 * integration went, their credential stopped being found — and the failure is
 * an absence, not an error: the picker simply opens as though they never had
 * one.
 *
 * `doctor` is the command someone runs when a credential stops being found, so
 * the sentence explaining it does work here. Anywhere else it would sit where
 * nobody looks.
 *
 * The list below is not written down twice: it is derived from what discovery
 * returned, so it cannot drift from what discovery does.
 */
export const credentialSourcesCheck: DoctorCheck = {
	id: 'providers.credentials',
	category: 'providers',
	run: async (): Promise<DoctorCheckResult> => {
		let detected: Awaited<ReturnType<typeof discoverProviders>>
		try {
			detected = await discoverProviders()
		} catch (err) {
			// Discovery is documented as non-throwing; if that ever stops being
			// true, say which step failed rather than reporting "no credentials".
			return {
				status: 'inconclusive',
				message: `credential discovery failed: ${err instanceof Error ? err.message : String(err)}`,
			}
		}

		if (detected.length === 0) {
			return {
				status: 'warn',
				message: 'no LLM credential found',
				remediation:
					'Namzu no longer reads the secrets file. It first reuses current Claude and Codex sessions on this device, then subscriptions signed in with `namzu login claude|codex`. API keys remain optional alternatives through ANTHROPIC_API_KEY or OPENAI_API_KEY; local Ollama and LM Studio servers are also detected.',
			}
		}

		const lines = detected.map((d) => {
			switch (d.source.kind) {
				case 'env':
					return `${d.entry.id} (env · ${d.source.envName})`
				case 'keychain':
					return `${d.entry.id} (keychain · ${d.source.service})`
				case 'claude-file':
					return `${d.entry.id} (Claude session · ${d.source.path})`
				case 'codex-file':
					return `${d.entry.id} (Codex session · ${d.source.path})`
				case 'stored':
					return `${d.entry.id} (signed in · ${d.source.path})`
				case 'probe':
					return `${d.entry.id} (local · ${d.source.url.replace(/^https?:\/\//, '')})`
				case 'session':
					return `${d.entry.id} (typed · current session)`
			}
		})
		return {
			status: 'pass',
			message: `${detected.length} provider credential(s) found: ${lines.join(', ')}`,
		}
	},
}
