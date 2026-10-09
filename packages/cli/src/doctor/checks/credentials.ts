import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { hasApiCredential } from '../../integrations/providers/access.js'
import { discoverProviders } from '../../integrations/providers/discover.js'
import {
	claudeCredentialSearchPaths as sessionSearchPaths,
	wslWindowsHome,
} from '../../integrations/providers/harness-credentials.js'
import { KEYCHAIN_SERVICE } from '../../integrations/providers/keychain.js'

function missingClaudeSessionNote(env: NodeJS.ProcessEnv, windowsHome: string | null): string {
	const paths = sessionSearchPaths(undefined, env, windowsHome)
	const keychain =
		process.platform === 'darwin' && !env.CLAUDE_CONFIG_DIR
			? ` and macOS Keychain service ${KEYCHAIN_SERVICE}`
			: ''
	return `Claude Code session not detected; checked ${paths.join(', ')}${keychain}. Desktop sign-in does not guarantee a reusable Claude Code CLI session; Namzu does not read Desktop's credential store. Sign in to the standalone Claude Code CLI, or run \`namzu login claude\`.`
}

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
	run: async (ctx): Promise<DoctorCheckResult> => {
		const env = ctx.env as NodeJS.ProcessEnv
		// Use one paired Windows home for discovery and its diagnostic, so the
		// reported paths are exactly the paths the credential readers checked.
		const windowsHome = wslWindowsHome(env)
		let detected: Awaited<ReturnType<typeof discoverProviders>>
		try {
			detected = await discoverProviders({ env, windowsHome })
		} catch (err) {
			// Discovery is documented as non-throwing; if that ever stops being
			// true, say which step failed rather than reporting "no credentials".
			return {
				status: 'inconclusive',
				message: `credential discovery failed: ${err instanceof Error ? err.message : String(err)}`,
			}
		}

		const missingClaude = !detected.some((provider) => provider.entry.id === 'anthropic')
		const missingNote = missingClaude ? missingClaudeSessionNote(env, windowsHome) : ''
		if (detected.length === 0) {
			return {
				status: 'warn',
				message: `no LLM credential found\n${missingNote}`,
				remediation:
					'Namzu no longer reads the secrets file. It first reuses current Claude and Codex sessions on this device, then subscriptions signed in with `namzu login claude|codex`. API keys remain optional alternatives through ANTHROPIC_API_KEY or OPENAI_API_KEY; local Ollama and LM Studio servers are also detected.',
			}
		}

		const lines = detected.map((d) => {
			switch (d.source.kind) {
				case 'env':
					if (d.entry.id === 'zen' && !hasApiCredential(d.entry, d.apiKey))
						return `${d.entry.id} (env · ${d.source.envName}=public; free models experimental)`
					return `${d.entry.id} (env · ${d.source.envName})`
				case 'public':
					return `${d.entry.id} (experimental free models · gateway may refuse)`
				case 'opencode-file':
					return `${d.entry.id} (OpenCode API key · ${d.source.path})`
				case 'keychain':
					return `${d.entry.id} (keychain · ${d.source.service})`
				case 'claude-file':
					return `${d.entry.id} (Claude session · ${d.source.path})`
				case 'gemini-file':
					return `${d.entry.id} (Gemini session · ${d.source.path})`
				case 'stored-gemini-key':
					return `${d.entry.id} (saved Gemini API key · ${d.source.path})`
				case 'stored-api-key':
					return `${d.entry.id} (saved API key · ${d.source.path})`
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
		const onlyAnonymousZen = detected.every(
			(d) => d.entry.id === 'zen' && !hasApiCredential(d.entry, d.apiKey),
		)
		return {
			status: onlyAnonymousZen ? 'warn' : 'pass',
			message: `${detected.length} provider source(s) discovered: ${lines.join(', ')}${missingNote ? `\n${missingNote}` : ''}`,
			...(onlyAnonymousZen
				? {
						remediation:
							'Zen free models are experimental; the gateway may refuse direct Namzu requests. OpenCode installation is recommended for its own client. If a turn is refused, configure OPENCODE_API_KEY or choose another provider.',
					}
				: {}),
		}
	},
}
