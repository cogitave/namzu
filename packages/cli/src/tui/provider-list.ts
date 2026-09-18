/**
 * The rows the provider picker lists: what this machine already has, then what
 * it could have if the operator supplied a credential.
 *
 * The second half is the point. The picker used to list only what discovery
 * found, so the one provider an operator had SAVED and held a key for — but had
 * not yet exported as an environment variable — appeared nowhere on a screen
 * that exists to choose a provider. There was no row to select and therefore no
 * way to type its key: a list that showed four providers had no fifth row for
 * the fifth one, and the screen's other exit (a sign-in) is a different kind of
 * credential entirely.
 *
 * ## What is added, and what is deliberately not
 *
 * A provider joins the list only when **this build can construct it** and it
 * **takes a credential the operator can type** — the registry's
 * `constructible` and `acceptsTypedCredential` flags, read together and read
 * from the registry rather than listed here. Entering a key for anything else
 * produces a row that leads nowhere, which is worse than an absent row:
 *
 *  - `bedrock` needs an AWS credential CHAIN (an access key, a secret, a
 *    region, a session token, or a role the SDK assumes) rather than one
 *    string. A single API-key field cannot express it, so the picker does not
 *    offer it.
 *  - `http` is a generic endpoint whose base URL is half the
 *    credential. A key with nowhere to send it is not a setup.
 *  - `lmstudio` cannot be constructed by this build at all.
 *  - `ollama` needs a local server, not a secret.
 *  - `codex` needs a device-code sign-in, which this screen already offers
 *    with `l` and names on the sign-in screen. It is skipped here so that one
 *    provider is not offered two different ways to be set up.
 *
 * `provider-list.test.ts` asserts that exclusion list by NAME, so a registry
 * flag that flips turns the test red instead of silently adding or dropping a
 * row.
 */

import {
	ALL_PROVIDER_IDS,
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type ProviderId,
	type ProviderRegistryEntry,
} from '../integrations/providers/index.js'

/**
 * One row of the picker.
 *
 * The two arms are rendered differently and behave differently on Enter, which
 * is why this is a union rather than a `DetectedProvider` with an optional key:
 * the second arm has no `source`, no `apiKey` and no alternatives, and a type
 * that pretended otherwise would let a caller ask a provider with no credential
 * what models it has.
 */
export type ProviderListRow =
	| { readonly kind: 'detected'; readonly detected: DetectedProvider }
	| { readonly kind: 'unconfigured'; readonly entry: ProviderRegistryEntry }

/** The provider a row is about, whichever kind of row it is. */
export function rowProviderId(row: ProviderListRow): ProviderId {
	return row.kind === 'detected' ? row.detected.entry.id : row.entry.id
}

/**
 * Providers this screen can set up by taking a credential from the operator.
 *
 * Derived from the registry, in registry order. Four of the twelve entries have
 * a driver in this repository and are not listed here, for the reasons in the
 * module comment.
 */
export function settableProviders(): readonly ProviderRegistryEntry[] {
	return ALL_PROVIDER_IDS.map((id) => PROVIDER_REGISTRY[id]).filter(
		(entry) => entry.constructible && entry.acceptsTypedCredential,
	)
}

/**
 * The full list, detected first and in the order discovery produced.
 *
 * Detected rows are passed through untouched: same order, same source text,
 * same numbering. Appending is what keeps that promise — anything that sorted,
 * merged or grouped the two together would move a row the operator has already
 * learned the position of.
 *
 * `includeUnconfigured` is false on the signed-in-subscription screen, which
 * offers only sessions that are already usable; a row needing a key contradicts
 * that screen's one sentence.
 */
export function providerListRows(
	detected: readonly DetectedProvider[],
	includeUnconfigured = true,
): readonly ProviderListRow[] {
	const rows: ProviderListRow[] = detected.map((provider) => ({
		kind: 'detected',
		detected: provider,
	}))
	if (!includeUnconfigured) return rows
	const known = new Set(detected.map((provider) => provider.entry.id))
	for (const entry of settableProviders()) {
		if (known.has(entry.id)) continue
		rows.push({ kind: 'unconfigured', entry })
	}
	return rows
}

/**
 * What an unconfigured row is missing, named as the thing to act on.
 *
 * The environment variable and not "not configured": the variable is the one
 * action that both makes the provider work now and keeps it working after a
 * restart, and a sentence that says only that something is absent leaves the
 * operator to find that name. `requiresApiKey: false` exists for providers
 * whose free catalogue works without one, so those are labelled optional rather
 * than needed.
 *
 * The fallback is unreachable for the current registry (every entry that
 * reaches this screen declares at least one variable) and is kept so that a
 * future entry without one prints a sentence rather than "needs undefined".
 */
export function credentialNeed(entry: ProviderRegistryEntry): string {
	const envName = entry.envVars[0]
	if (!envName) return 'needs a credential'
	return entry.requiresApiKey ? `needs ${envName}` : `${envName} optional`
}

/**
 * Where the cursor starts.
 *
 * The provider in force, else the one this screen was opened for — the saved
 * provider whose credential is missing — else the top of the list.
 *
 * The middle case is why this is a function rather than one `findIndex`. A
 * saved provider with no credential is not on the machine, so it is not in
 * `detected`, so it used to fall through to row 1: the picker opened saying
 * "no credential found" for the saved provider with the cursor elsewhere. Now the
 * highlighted row IS the row that needs the key, which is also the row `k`
 * targets.
 */
export function initialProviderRow(
	rows: readonly ProviderListRow[],
	currentProvider: string | null | undefined,
	keyEntryFor: ProviderId | null | undefined,
): number {
	if (currentProvider !== null && currentProvider !== undefined) {
		const at = rows.findIndex((row) => rowProviderId(row) === currentProvider)
		if (at >= 0) return at
	}
	if (keyEntryFor !== null && keyEntryFor !== undefined) {
		const at = rows.findIndex((row) => rowProviderId(row) === keyEntryFor)
		if (at >= 0) return at
	}
	return 0
}
