/**
 * `--fallback-model <provider/model[,…]>`: a provider chain for one run.
 *
 * Each entry names a model to fall over to when the one before it cannot
 * answer, tried in order. The chain is built the way `providers.chain` is (the
 * same members, the same fall-over, the same notice when one takes over), but
 * only for this run: nothing is written to the saved preferences.
 *
 * An entry is read as follows:
 *   - `provider/model`  that model on that provider, when `provider` is one Namzu knows
 *   - `provider`        that provider's default model
 *   - anything else     that model on the primary's provider
 *
 * Like `--provider`, naming fallbacks REPLACES the saved ones: an operator who
 * spells out where a run may fall over to has said all of it, and a saved
 * provider they did not name must not answer in its place.
 */

import type { Preferences, ProviderChoice } from './preferences.js'
import { PROVIDER_REGISTRY, type ProviderId } from './registry.js'

function isProviderId(value: string): value is ProviderId {
	return Object.hasOwn(PROVIDER_REGISTRY, value)
}

/** The entries one or more flag values name, in order. */
export function splitFallbackModels(values: readonly string[]): string[] {
	return values.flatMap((value) =>
		value
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean),
	)
}

/** One entry as a chain member, given the provider that serves first. */
export function parseFallbackEntry(entry: string, primary: ProviderId): ProviderChoice {
	if (isProviderId(entry)) return { id: entry }
	const slash = entry.indexOf('/')
	if (slash > 0) {
		const head = entry.slice(0, slash)
		const model = entry.slice(slash + 1).trim()
		if (isProviderId(head) && model) return { id: head, model }
	}
	return { id: primary, model: entry }
}

/**
 * The chain with the flag's fallbacks after the primary. A member that repeats
 * one already in the chain is dropped, since a duplicate could never serve.
 */
export function applyFallbackFlag(prefs: Preferences, values: readonly string[]): Preferences {
	const entries = splitFallbackModels(values)
	if (entries.length === 0) return prefs
	const [primary] = prefs.providers
	if (!primary) return prefs
	const chain: ProviderChoice[] = [primary]
	for (const entry of entries) {
		const member = parseFallbackEntry(entry, primary.id)
		const repeats = chain.some((seen) => seen.id === member.id && seen.model === member.model)
		if (!repeats) chain.push(member)
	}
	return { ...prefs, providers: chain }
}
