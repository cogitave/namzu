/**
 * The rows the provider picker lists: one per vendor, each saying what this
 * machine can currently do with it.
 *
 * ## One vendor is one row
 *
 * The screen used to draw a row per provider id, so one vendor could be two
 * rows: the session on the device under the subscription's own label, and below
 * it the same vendor's name asking for the key it did not need. The operator
 * holding the key had to work out which of the two rows was theirs.
 *
 * Rows are grouped by `ProviderRegistryEntry.vendor` — a field on the registry
 * rather than a table here, because which ids are one vendor is a fact about
 * the providers and the picker is only the first surface to need it; see
 * `VENDOR_NAMES` for that field and for which ids are one vendor. A vendor
 * whose ids reach the same service through different credentials is one row,
 * which is the shape one entry in this registry has had all along: a single id
 * taking an API key, a token variable, or a signed-in session. A vendor with
 * two catalogues keeps two rows, because merging those would put a product
 * decision inside a screen about credentials.
 *
 * ## What a row says, and what it holds
 *
 * The second column is what the machine has, not what the ideal setup is: the
 * source of a session discovery found (`Codex session · this device`), or — when
 * nothing was found for that vendor — the variable that would set it up
 * (`needs OPENAI_API_KEY`). The variable is named rather than "not configured"
 * because it is the one action that both makes the provider work now and keeps
 * it working after a restart.
 *
 * Every way in that this build can offer is below in `paths`, in the order the
 * screen offers them: what is already detected, then the API key, then — where
 * nothing works yet — a sign-in the registry declares. A row whose paths name
 * ONE provider id leads straight to that provider's flow, exactly as it did
 * before this file grouped anything — Enter on an unconfigured row opens its
 * paste field, Enter on a detected one opens its models. A row whose paths name
 * SEVERAL ids cannot answer Enter by itself, so the screen asks which one; that
 * is the only place this change added a step to, and in the registry as it
 * stands it is one row: the vendor whose subscription session and API key are
 * two ids.
 *
 * ## What is added, and what is deliberately not
 *
 * A vendor joins the list only when **this build can construct something in it**
 * and it **takes a credential the operator can type** — the registry's
 * `constructible` and `acceptsTypedCredential` flags, read together and read
 * from the registry rather than listed here. Entering a key for anything else
 * produces a row that leads nowhere, which is worse than an absent row:
 *
 *  - `bedrock` needs an AWS credential CHAIN (an access key, a secret, a
 *    region, a session token, or a role the SDK assumes) rather than one
 *    string. A single API-key field cannot express it, so the picker does not
 *    offer it.
 *  - `http` is a generic endpoint whose base URL is half the credential. A key
 *    with nowhere to send it is not a setup.
 *  - `lmstudio` cannot be constructed by this build at all. Discovery may still
 *    find it, and a row for something genuinely on the machine stays on the
 *    machine's list — it just refuses, with the reason, when accepted.
 *  - `ollama` needs a local server, not a secret. A running server is how
 *    discovery finds it, and that is the only way it is listed.
 *
 * The sign-in inside a vendor row is not a second way to set that vendor up
 * beside the first; it is the same path `l` reaches today, offered where the
 * operator is already looking. Nothing here starts a credential flow of its
 * own: a path names a provider the rest of the screen already knows how to
 * handle.
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
	VENDOR_NAMES,
	type VendorId,
	providerEntriesOfVendor,
} from '../integrations/providers/index.js'

/**
 * One way this build can be set up to use a vendor.
 *
 * A union rather than a `ProviderRegistryEntry` with flags, because the three
 * lead to three different places and carry three different things: a detected
 * source leads to a model listing that only exists because a credential was
 * found, a credential leads to the field that takes one, and a sign-in leads to
 * an operation that is not a value at all. A type that flattened them would let
 * a caller ask a path that has no credential what models it has.
 */
export type VendorPath =
	/** Something on this machine already works. */
	| { readonly kind: 'detected'; readonly detected: DetectedProvider }
	/** A provider whose credential the operator can type into the paste field. */
	| { readonly kind: 'credential'; readonly entry: ProviderRegistryEntry }
	/** A Namzu-owned sign-in — the operation `l` starts today. */
	| { readonly kind: 'sign-in'; readonly entry: ProviderRegistryEntry }

/** The provider a path is about, whichever kind of path it is. */
export function pathProviderId(path: VendorPath): ProviderId {
	return path.kind === 'detected' ? path.detected.entry.id : path.entry.id
}

/**
 * One row of the picker: a vendor, what this machine has for it, and every way
 * in this build can offer.
 *
 * `detected` is kept beside `paths` rather than folded into it because the two
 * answer different questions. `paths` is what the row can DO — and a detected
 * provider this build cannot construct is therefore not a path, since following
 * it only reaches a refusal — while `detected` is what the machine HAS, which
 * is what the row's second column reports and what the refusal names. A row
 * that dropped the second would hide a discovery that genuinely happened.
 */
export interface VendorRow {
	readonly vendor: VendorId
	/** What the row is called, from the registry's one name for that vendor. */
	readonly label: string
	/** What this machine has for the vendor, in discovery order. */
	readonly detected: readonly DetectedProvider[]
	/** The ways in, in the order the screen offers them. */
	readonly paths: readonly VendorPath[]
}

/**
 * Providers this screen can set up by taking a credential from the operator.
 *
 * Derived from the registry, in registry order. Five of the twelve entries have
 * a driver in this repository and are not listed here, for the reasons in the
 * module comment. `codex` is not among them either, and for a different reason:
 * it takes no typed credential at all, and it is offered instead as the
 * sign-in path of the vendor row it shares with the key entry beside it.
 */
export function settableProviders(): readonly ProviderRegistryEntry[] {
	return ALL_PROVIDER_IDS.map((id) => PROVIDER_REGISTRY[id]).filter(
		(entry) => entry.constructible && entry.acceptsTypedCredential,
	)
}

/**
 * Every way one vendor can be used, in the order the screen offers them:
 * what is already detected, then the API key, then — where nothing works yet —
 * a sign-in the registry declares.
 *
 * `entries` is passed rather than looked up so this can be read by a test
 * against a vendor no registry holds — the shape of the answer is a fact about
 * the flags, and the alternative is a rule only checkable by editing the
 * registry.
 *
 * An id that was already detected is never offered a second time as a way in.
 * It is already usable, and listing it twice would put the same provider on the
 * row under two headings, which is the shape this file exists to remove.
 *
 * ## Why a sign-in is offered only where nothing works yet
 *
 * A sign-in is how a vendor with nothing becomes usable. A vendor that is
 * already usable has no such gap, and the operator who wants a SECOND way in —
 * a Namzu-owned session beside the key they exported — is asking for something
 * else: `l` starts one from any screen, and the footer says so. Offering it
 * here as well would put a question in front of every operator whose key works
 * and stop them answering it, once per launch, to serve a case that has another
 * door. The vendor with a signed-in session and no key still shows both, which
 * is the case this row was reported for.
 *
 * `includeUnconfigured` is false on the signed-in-subscription screen, which
 * offers only sessions that are already usable; an API key path there would
 * contradict that screen's one sentence.
 */
export function vendorPaths(
	entries: readonly ProviderRegistryEntry[],
	detected: readonly DetectedProvider[],
	includeUnconfigured: boolean,
): readonly VendorPath[] {
	const paths: VendorPath[] = []
	const found = new Set(detected.map((provider) => provider.entry.id))
	for (const provider of detected) {
		// A provider this build cannot construct is not a way in. It stays in the
		// row's `detected` so the row can say what it found and refuse with the
		// reason — see `VendorRow`.
		if (!provider.entry.constructible) continue
		paths.push({ kind: 'detected', detected: provider })
	}
	if (!includeUnconfigured) return paths
	const alreadyUsable = paths.length > 0
	for (const entry of entries) {
		if (found.has(entry.id)) continue
		if (!entry.constructible || !entry.acceptsTypedCredential) continue
		paths.push({ kind: 'credential', entry })
	}
	if (alreadyUsable) return paths
	for (const entry of entries) {
		if (found.has(entry.id)) continue
		if (!entry.constructible || entry.subscriptionLogin === undefined) continue
		paths.push({ kind: 'sign-in', entry })
	}
	return paths
}

/**
 * The full list, detected first and in the order discovery produced.
 *
 * A vendor takes the position of the first provider detected for it, so the
 * detected block keeps discovery's order and one vendor never appears in it
 * twice. The block below keeps registry order — the order of the entries that
 * can be set up, which is the order the screen drew those rows in before
 * anything was grouped.
 *
 * `includeUnconfigured` is false on the signed-in-subscription screen, which
 * offers only sessions that are already usable.
 */
export function providerListRows(
	detected: readonly DetectedProvider[],
	includeUnconfigured = true,
): readonly VendorRow[] {
	const order: VendorId[] = []
	const byVendor = new Map<VendorId, DetectedProvider[]>()
	for (const provider of detected) {
		const vendor = provider.entry.vendor
		const group = byVendor.get(vendor)
		if (group) {
			group.push(provider)
			continue
		}
		byVendor.set(vendor, [provider])
		order.push(vendor)
	}
	if (includeUnconfigured) {
		for (const entry of settableProviders()) {
			if (byVendor.has(entry.vendor)) continue
			byVendor.set(entry.vendor, [])
			order.push(entry.vendor)
		}
	}
	return order.map((vendor) => {
		const group = byVendor.get(vendor) ?? []
		return {
			vendor,
			label: VENDOR_NAMES[vendor],
			detected: group,
			paths: vendorPaths(providerEntriesOfVendor(vendor), group, includeUnconfigured),
		}
	})
}

/**
 * Whether anything on this row can be used at all.
 *
 * False means the row is a discovery this build cannot construct — the one case
 * where the screen may list something it must then refuse, rather than a row
 * that needs a credential first.
 */
export function rowIsUsable(row: VendorRow): boolean {
	return row.paths.length > 0
}

/**
 * Whether entering the row has to ask which provider it means.
 *
 * True exactly when the row's paths name more than one provider id, which in
 * the current registry is the one vendor whose two ids are a subscription and a
 * key: those are different providers with different catalogues, so which one
 * the operator wants is theirs to say and not the screen's to assume. A row
 * whose paths all name ONE provider is not asked: the paths there are
 * alternative credentials for the same provider, `k` and `l` already reach the
 * ones Enter does not, and an intermediate menu would cost every operator a
 * keystroke to answer a question that has one answer.
 */
export function rowNeedsChoice(row: VendorRow): boolean {
	return new Set(row.paths.map(pathProviderId)).size > 1
}

/**
 * The entry a typed credential would be taken for on this row, if there is one.
 *
 * Asked of the whole vendor and not of the row's paths, deliberately: `k` takes
 * a credential for the provider under the cursor so it can be used for THIS
 * session, which is meaningful even when that provider is already detected and
 * therefore has no credential path — a detected vendor is not one whose key the
 * operator may not replace for the next hour.
 *
 * `acceptsTypedCredential` alone, and not `constructible` beside it, because
 * this is the question `k` has always asked of the highlighted row. A detected
 * provider this build cannot construct still takes a typed credential, and
 * answering "it does not" would be false about the provider to make a point
 * about the build — which is the refusal the row itself gives when it is
 * accepted, in the words `unsupportedProviderMessage` writes.
 */
export function typedCredentialEntry(
	row: VendorRow | undefined,
): ProviderRegistryEntry | undefined {
	if (!row) return undefined
	return providerEntriesOfVendor(row.vendor).find((entry) => entry.acceptsTypedCredential)
}

/**
 * What a row with nothing detected is missing, named as the thing to act on.
 *
 * Null for a vendor whose members take no typed credential — a local server, or
 * a vendor this build cannot construct — because those rows have a source
 * column that says something else and a sentence here would name a variable
 * nobody can use.
 */
export function rowCredentialNeed(row: VendorRow): string | null {
	const entry = typedCredentialEntry(row)
	return entry ? credentialNeed(entry) : null
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

/** Whether a row is about a given provider id — detected there, or a way in. */
export function rowHasProvider(row: VendorRow, id: string): boolean {
	return (
		row.detected.some((provider) => provider.entry.id === id) ||
		row.paths.some((path) => pathProviderId(path) === id)
	)
}

/** The index of the row holding a provider, or -1 when no row does. */
export function rowIndexOfProvider(
	rows: readonly VendorRow[],
	id: string | null | undefined,
): number {
	if (id === null || id === undefined) return -1
	return rows.findIndex((row) => rowHasProvider(row, id))
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
 * targets. Both lookups ask the row, not the vendor: a saved `codex` and a
 * saved subscription id and a saved key id are the same row, and either one
 * lands the cursor on it.
 */
export function initialProviderRow(
	rows: readonly VendorRow[],
	currentProvider: string | null | undefined,
	keyEntryFor: ProviderId | null | undefined,
): number {
	const current = rowIndexOfProvider(rows, currentProvider)
	if (current >= 0) return current
	const entry = rowIndexOfProvider(rows, keyEntryFor)
	if (entry >= 0) return entry
	return 0
}
