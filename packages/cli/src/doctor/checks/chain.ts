import { homedir } from 'node:os'

import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import {
	chainCapabilityDisagreements,
	unresolvedMembers,
} from '../../integrations/providers/chain-capabilities.js'
import { type DiscoverOptions, discoverProviders } from '../../integrations/providers/discover.js'
import { preferencesPath, readPreferences } from '../../integrations/providers/preferences.js'
import { resolveChainCapabilities } from '../../integrations/providers/register.js'
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
 * ## Two ways a chain is unusable, and this reports both
 *
 * A credential is the obvious one. The other is a capability DISAGREEMENT: a
 * run negotiates tools, vision and documents once, against the primary, and
 * keeps that answer across a swap — so a chain whose members declare different
 * abilities would land a run on a member holding a request shaped for someone
 * else. `createAgentSession` refuses such a chain outright, which means an
 * operator who has one learns about it by trying to start a session.
 *
 * That check used to be unreachable from here. Reading what a provider declares
 * requires its package to be registered, and the only registration path lived
 * inside the interactive session module — so `doctor` could report which
 * members had keys and not whether the chain it was describing could run at
 * all. A diagnostic that cannot see what the thing it diagnoses sees is
 * checking the wrong thing. `ensureRegistered` now lives beside the registry
 * (`integrations/providers/register.ts`) and both reach it.
 *
 * The cost is real and worth naming: this check dynamically imports the driver
 * package of every member in the chain. That is the price of reading a
 * declaration, and it is paid on a command whose entire job is to look.
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
		// `skipped`: this check LOOKED and there is no chain here to describe.
		// Not `inconclusive`, which now means the check could not answer — the
		// answer was reached, and it is "there is none".
		//
		// Not `warn` either, which in this file means namzu is usable but
		// degraded. A machine with no preferences file and a key in the
		// environment is an ordinary working namzu: `run` builds a default chain
		// from what it detects, and whether a credential exists at all is
		// `providers.credentials`' question, answered there and not restated
		// here.
		return {
			status: 'skipped',
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
			...(options.home ? { home: options.home } : {}),
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
		// `(namzu default)`, not `(default)`. The value comes from namzu's own
		// provider registry, and a bare "default" reads as the provider's current
		// one — so an operator seeing a model they did not expect concludes the
		// provider changed it, when the thing to do is pin `model` on this member.
		// The picker already says it this way; this line is the same value.
		const model = member.model ?? `${entry.defaultModel} (namzu default)`
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

	// What each member DECLARES. Type-level, so no credential is needed — which
	// is what makes it answerable about the fallback nobody has configured yet,
	// the member most worth asking about.
	const resolved = await resolveChainCapabilities(members)
	const disagreements = chainCapabilityDisagreements(members, resolved)
	const accepted = read.prefs.allowCapabilityMismatch === true
	const unreadable = unresolvedMembers(members, resolved)
	const primaryUnreadable = resolved[0]?.kind === 'unresolved'

	const sections: string[] = [chain]
	if (disagreements.length > 0) {
		sections.push(
			accepted
				? 'The members declare different capabilities, and you have accepted that:'
				: 'The members declare different capabilities, so a session will be REFUSED:',
			...disagreements.map((d) => `  - ${d.sentence}`),
		)
	}
	if (unreadable.length > 0) {
		// Kept separate from the disagreements above, for the reason the session
		// keeps them separate: a member whose declaration could not be read is not
		// a member that disagrees, and reporting it as one would name a conflict
		// nobody established.
		sections.push(
			'Could not read what these members declare:',
			...unreadable.map((line) => `  - ${line}`),
		)
	}
	const message = sections.join('\n')

	// Ordered by what stops a run. An unaccepted disagreement and an unusable
	// primary both mean no session starts at all; everything else leaves namzu
	// working with less than the operator declared.
	if (disagreements.length > 0 && !accepted) {
		return {
			status: 'fail',
			message: `provider chain cannot be honoured as written:\n${message}`,
			remediation:
				'Drop the member that disagrees, or set "allowCapabilityMismatch": true in your preferences to accept the limitation. namzu will not choose between advertising abilities a fallback lacks and costing your primary a capability on every run.',
		}
	}
	if (primaryUnusable || primaryUnreadable) {
		return {
			status: 'fail',
			message: `${unusable} of ${members.length} chain member(s) cannot be used:\n${message}`,
			remediation: primaryUnusable
				? 'The primary provider has no usable credential, so no run can start. Set its key, or run `namzu` to pick a provider that has one.'
				: 'The primary provider could not be loaded, so no run can start. Run `namzu` to pick a provider that can.',
		}
	}
	if (unusable > 0 || unreadable.length > 0 || disagreements.length > 0) {
		return {
			// `warn`, not `fail`: the primary still runs, so namzu is usable and the
			// operator is not blocked by a degraded spare.
			status: 'warn',
			message:
				unusable > 0
					? `${unusable} of ${members.length} chain member(s) cannot be used:\n${message}`
					: `provider chain usable, with limitations:\n${message}`,
			remediation:
				unusable > 0
					? 'The primary still works, so runs will start. But a fallback with no credential is not a fallback — set its key, or take it out of the chain.'
					: 'The primary still works. A fallback that declares less than your primary will serve shorter or less capable turns if the chain ever falls over to it.',
		}
	}

	return {
		status: 'pass',
		message:
			members.length === 1
				? `1 provider configured (no fallback):\n${message}`
				: `${members.length} providers configured, in order:\n${message}`,
	}
}

export const providerChainCheck: DoctorCheck = {
	id: 'providers.chain',
	category: 'providers',
	run: (ctx): Promise<DoctorCheckResult> => describeProviderChain({ env: ctx.env }),
}
