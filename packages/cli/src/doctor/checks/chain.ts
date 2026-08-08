import { homedir } from 'node:os'

import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { type DiscoverOptions, discoverProviders } from '../../integrations/providers/discover.js'
import { preferencesPath, readPreferences } from '../../integrations/providers/preferences.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'

export interface ProviderChainCheckOptions {
	/** Where `.namzu/preferences.json` lives. Defaults to the real home. */
	readonly home?: string
	readonly env?: DiscoverOptions['env']
	/** Skip localhost probes. Off in production: a local server being up is the answer. */
	readonly skipProbes?: boolean
}

/**
 * The configured provider chain, in the operator's declared order.
 *
 * Two jobs, and the second is the one that earns this check.
 *
 * First, the order has to be readable without launching the TUI. A chain that
 * can only be seen by opening an interactive picker is not something an
 * operator can check on a server, paste into an issue, or diff after an edit.
 *
 * Second — and this is why it reports per MEMBER rather than a count — a
 * fallback is only worth having if it works, and a broken one is invisible by
 * construction: nothing exercises it until the primary is already down, which
 * is the worst moment to find out the key was never set. So every member's
 * credential is resolved here, on a day when nothing is broken.
 *
 * Exported separately from the `DoctorCheck` so it can be driven with an
 * explicit home and environment. The check itself is still exercised through
 * `providerChainCheck.run`, because a helper proven in isolation says nothing
 * about whether the check reaches it.
 */
export async function describeProviderChain(
	options: ProviderChainCheckOptions = {},
): Promise<DoctorCheckResult> {
	const home = options.home ?? homedir()
	const path = preferencesPath(home)

	let read: ReturnType<typeof readPreferences>
	try {
		read = readPreferences(home)
	} catch (err) {
		return {
			status: 'fail',
			message: `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
			remediation: 'Fix or delete the file, then run `namzu` to pick a provider again.',
		}
	}

	if (read.status === 'missing') {
		return {
			status: 'inconclusive',
			message: `no provider chain configured (${path} does not exist)`,
			remediation: 'Run `namzu` and pick a provider; the choice is saved to that file.',
		}
	}
	if (read.status === 'needs-repick') {
		return {
			status: 'fail',
			message: `provider chain unusable: ${read.reason}`,
			remediation: 'Run `namzu` to pick again, or edit that file by hand.',
		}
	}

	let detected: Awaited<ReturnType<typeof discoverProviders>>
	try {
		detected = await discoverProviders({
			...(options.env ? { env: options.env } : {}),
			...(options.skipProbes ? { skipProbes: true } : {}),
		})
	} catch (err) {
		// Name the step that failed. Reporting "no credentials" when discovery
		// itself broke would send the operator looking for a key that is
		// already there.
		return {
			status: 'inconclusive',
			message: `provider chain read, but credential discovery failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		}
	}

	const members = read.prefs.providers
	const lines: string[] = []
	let unusable = 0
	let primaryUnusable = false

	for (const [index, member] of members.entries()) {
		const entry = PROVIDER_REGISTRY[member.id]
		const position = index === 0 ? 'primary' : `fallback ${index}`
		const model = member.model ?? `${entry.defaultModel} (default)`
		const det = detected.find((d) => d.entry.id === member.id)
		const usable = entry.requiresApiKey ? Boolean(det?.apiKey) : Boolean(det)
		if (!usable) {
			unusable++
			if (index === 0) primaryUnusable = true
		}
		const state = entry.requiresApiKey
			? usable
				? 'credential found'
				: 'NO CREDENTIAL'
			: usable
				? 'reachable'
				: 'NOT REACHABLE'
		lines.push(`${index + 1}. ${position} · ${entry.label} · ${model} · ${state}`)
	}

	const chain = lines.join('\n')

	if (unusable === 0) {
		return {
			status: 'pass',
			message:
				members.length === 1
					? `1 provider configured (no fallback):\n${chain}`
					: `${members.length} providers configured, in order:\n${chain}`,
		}
	}

	return {
		// `warn`, not `fail`, when only a fallback is broken: the primary still
		// runs, so namzu is usable and the operator is not blocked by a
		// degraded spare. A broken PRIMARY stops every run, and reads as such.
		status: primaryUnusable ? 'fail' : 'warn',
		message: `${unusable} of ${members.length} chain member(s) cannot be used:\n${chain}`,
		remediation: primaryUnusable
			? 'The primary provider has no usable credential, so no run can start. Set its key, or run `namzu` to pick a provider that has one.'
			: 'The primary still works, so runs will start. But a fallback with no credential is not a fallback — set its key, or take it out of the chain.',
	}
}

export const providerChainCheck: DoctorCheck = {
	id: 'providers.chain',
	category: 'providers',
	run: (ctx): Promise<DoctorCheckResult> => describeProviderChain({ env: ctx.env }),
}
