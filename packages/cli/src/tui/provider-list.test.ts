/**
 * What the provider picker lists, and what it refuses to.
 *
 * The list is the whole feature and it is pure, so it is decided here rather
 * than through a rendered frame: which rows exist, in what order, what each one
 * says is missing, and — since one vendor became one row — which ways in each
 * row offers and in what order. The screen's side of it — that Enter on such a
 * row opens the credential field or the choice between providers, and hands the
 * typed value up — is in `__tests__/a-vendor-row-offers-every-way-in.test.tsx`
 * and `__tests__/every-provider-you-can-set-up-is-on-the-list.test.tsx`.
 */

import { describe, expect, it } from 'vitest'

import {
	ALL_PROVIDER_IDS,
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type ProviderRegistryEntry,
	providerEntriesOfVendor,
} from '../integrations/providers/index.js'
import {
	type VendorRow,
	credentialNeed,
	initialProviderRow,
	pathProviderId,
	providerListRows,
	rowHasProvider,
	rowIndexOfProvider,
	rowIsUsable,
	rowNeedsChoice,
	settableProviders,
	typedCredentialEntry,
	vendorPaths,
} from './provider-list.js'

const LOCAL_OLLAMA: DetectedProvider = {
	entry: PROVIDER_REGISTRY.ollama,
	source: { kind: 'probe', url: 'http://localhost:11434' },
	alternatives: [],
}

const LOCAL_LMSTUDIO: DetectedProvider = {
	entry: PROVIDER_REGISTRY.lmstudio,
	source: { kind: 'probe', url: 'http://localhost:1234/v1/models' },
	alternatives: [],
}

const CODEX_DEVICE: DetectedProvider = {
	entry: PROVIDER_REGISTRY.codex,
	source: { kind: 'codex-file', path: '/device/.codex/auth.json' },
	apiKey: 'never-render-this-token',
	alternatives: [],
}

const FREE_ZEN: DetectedProvider = {
	entry: PROVIDER_REGISTRY.zen,
	source: { kind: 'public' },
	alternatives: [],
}

/** A signed-in session, which is a different way in from a key. */
const CLAUDE_DEVICE: DetectedProvider = {
	entry: PROVIDER_REGISTRY['anthropic'],
	source: { kind: 'claude-file', path: '/device/.claude/.credentials.json' },
	apiKey: 'claude-device-token',
	alternatives: [],
}

/** The same, from the CLI Google ships — discovery reports it as a session. */
const GEMINI_SESSION: DetectedProvider = {
	entry: PROVIDER_REGISTRY.google,
	source: { kind: 'gemini-file', path: '/device/.gemini/oauth.json' },
	apiKey: 'gemini-session-token',
	alternatives: [],
}

/**
 * The row a provider is on, whichever id of it is asked about.
 *
 * Throws rather than returning undefined, so the tests about what a row offers
 * read as statements about a row instead of about a maybe-row. A test asking for
 * a row the list does not have has a defect of its own, and says so here.
 */
function rowOf(rows: readonly VendorRow[], id: string): VendorRow {
	const row = rows.find((candidate) => rowHasProvider(candidate, id))
	if (!row) throw new Error(`no row of the list holds "${id}"`)
	return row
}

/**
 * Every provider id a row can reach: the ones found, and the ways in.
 *
 * A set, because a detected provider is also a path — the question this answers
 * is what is REACHABLE from the list, and a provider reachable two ways is one
 * reachable id.
 */
const reachableIds = (rows: readonly VendorRow[]): string[] => [
	...new Set(
		rows.flatMap((row) => [
			...row.detected.map((provider) => provider.entry.id),
			...row.paths.map(pathProviderId),
		]),
	),
]

describe('the rows a picker draws', () => {
	it('keeps the detected rows first, in the order discovery produced them', () => {
		// Discovery sorts anonymous access last, and that order is the screen's
		// order. Appending is what keeps it: anything that merged the two groups
		// would move a row the operator has already learned the position of.
		const rows = providerListRows([FREE_ZEN, LOCAL_OLLAMA])

		expect(rows.slice(0, 2).map((row) => row.vendor)).toEqual(['zen', 'ollama'])
		expect(rows.slice(0, 2).every((row) => row.detected.length > 0)).toBe(true)
	})

	it('adds a vendor nothing on this machine serves, named by the variable it needs', () => {
		// The defect this is written against: a saved provider with a key the
		// operator holds and has not exported appeared nowhere on the screen that
		// exists to choose a provider, so there was no row to select and no way to
		// type the key.
		const openrouter = rowOf(providerListRows([LOCAL_OLLAMA]), 'openrouter')

		expect(openrouter.vendor).toBe('openrouter')
		expect(credentialNeed(PROVIDER_REGISTRY.openrouter)).toBe('needs OPENROUTER_API_KEY')
	})

	it('leaves out every provider this screen cannot set up', () => {
		// Asserted by NAME, so that a registry flag which flips turns this red
		// instead of silently adding or removing a row. Each omission has a
		// reason, and the reason is why the row would lead nowhere:
		//
		//  - `ollama` needs a local server rather than a secret, and a running
		//    server is how discovery finds it.
		//  - `lmstudio` is not constructible in this build at all.
		//  - `bedrock` needs an AWS credential chain (key, secret, region, or a
		//    role the SDK assumes), which one field cannot express.
		//  - `http` is an endpoint whose base URL is half the credential; a key
		//    with nowhere to send it is not a setup.
		//
		// `codex` is no longer on this list, and that is the point of the change:
		// it takes no typed credential, so it is not a row this screen sets up,
		// but it IS the sign-in path of the row it shares with the vendor's key —
		// so it is reachable from the list where it used to be only reachable
		// from `l`.
		const listed = new Set(reachableIds(providerListRows([])))

		expect(ALL_PROVIDER_IDS.filter((id) => !listed.has(id))).toEqual([
			'ollama',
			'lmstudio',
			'bedrock',
			'http',
		])
	})

	it('lists nothing twice when a settable provider was also detected', () => {
		const rows = providerListRows([FREE_ZEN, LOCAL_OLLAMA])
		const vendors = rows.map((row) => row.vendor)

		expect(vendors).toHaveLength(new Set(vendors).size)
		expect(vendors.filter((vendor) => vendor === 'zen')).toHaveLength(1)
	})

	it('offers the detected rows alone where only usable sessions belong', () => {
		// The signed-in-subscription screen asks which session to use. A row that
		// needs a key first makes that sentence false, and so does a path that
		// would ask for one.
		const rows = providerListRows([FREE_ZEN], false)

		expect(rows.map((row) => row.vendor)).toEqual(['zen'])
		expect(rows.every((row) => row.paths.every((path) => path.kind === 'detected'))).toBe(true)
	})

	it('derives what it can set up from the registry, never from a second list', () => {
		expect(settableProviders().map((entry) => entry.id)).toEqual(
			ALL_PROVIDER_IDS.filter(
				(id) => PROVIDER_REGISTRY[id].constructible && PROVIDER_REGISTRY[id].acceptsTypedCredential,
			),
		)
	})

	it('draws at most nine rows, which is what the digit shortcut reaches', () => {
		// The ceiling is nine because there are nine vendors this screen can draw
		// — the seven that can be set up with a typed credential, plus the two
		// local servers that only discovery can add. Before one vendor became one
		// row, this input drew ten: the subscription and the API key were two rows
		// for one vendor, and the tenth row was the duplicate.
		const rows = providerListRows([CODEX_DEVICE, LOCAL_OLLAMA, LOCAL_LMSTUDIO])

		expect(rows).toHaveLength(9)
	})
})

describe('one vendor is one row', () => {
	it('draws one row for the vendor whose two ids are a subscription and a key', () => {
		const rows = providerListRows([CODEX_DEVICE, LOCAL_OLLAMA])
		const subscriptionRows = rows.filter((row) => rowHasProvider(row, 'codex'))

		expect(subscriptionRows).toHaveLength(1)
		// Both ids reachable, and neither is a second row: the key is a way in on
		// the same row the session is on.
		expect(rowOf(rows, 'openai')).toBe(subscriptionRows[0])
		expect(reachableIds(rows).filter((id) => id === 'codex' || id === 'openai')).toEqual([
			'codex',
			'openai',
		])
	})

	it('offers what was found first, then the key, then a sign-in', () => {
		// The order is the answer to "what does entering this row do, when there is
		// more than one thing it could do": the session already on the device, then
		// the credential the operator can type, then an operation they can start.
		const withSession = rowOf(providerListRows([CODEX_DEVICE]), 'codex')
		expect(withSession.paths.map((path) => `${path.kind}:${pathProviderId(path)}`)).toEqual([
			'detected:codex',
			'credential:openai',
		])

		const withoutSession = rowOf(providerListRows([LOCAL_OLLAMA]), 'openai')
		expect(withoutSession.paths.map((path) => `${path.kind}:${pathProviderId(path)}`)).toEqual([
			'credential:openai',
			'sign-in:codex',
		])
	})

	it('asks how the row is meant to be used when it has more than one way in', () => {
		// The question is about WAYS, and it is asked exactly when there is more
		// than one — in both directions. A row with two ways that come from one id
		// is asked (a session AND a key on one entry); a row with one way is not,
		// whatever it took to declare it.
		const rows = providerListRows([CODEX_DEVICE, LOCAL_OLLAMA])

		expect(rowNeedsChoice(rowOf(rows, 'codex'))).toBe(true)
		expect(rowNeedsChoice(rowOf(rows, 'ollama'))).toBe(false)
		expect(rowNeedsChoice(rowOf(providerListRows([LOCAL_OLLAMA]), 'deepseek'))).toBe(false)
		expect(rowNeedsChoice(rowOf(providerListRows([]), 'openrouter'))).toBe(false)
	})

	it('offers the key beside a signed-in session, which is a different way in', () => {
		// The gap the owner's rule closed. One entry takes a session and a key, so
		// a machine with the session found has two real choices: keep using it, or
		// enter a key of one's own. The row asked nothing before, because both ways
		// came from one id.
		const rows = providerListRows([CLAUDE_DEVICE])
		const bothWays = rowOf(rows, 'anthropic')

		expect(bothWays.paths.map((path) => `${path.kind}:${pathProviderId(path)}`)).toEqual([
			'detected:anthropic',
			'credential:anthropic',
		])
		expect(rowNeedsChoice(bothWays)).toBe(true)
	})

	it('offers the key beside a free catalogue, which works without one', () => {
		// `zen` declares `requiresApiKey: false`: the free models are a way in on
		// their own, and a key is a second one. The row says so, and the free way
		// is first because it is what discovery found.
		const rows = providerListRows([FREE_ZEN])
		const zen = rowOf(rows, 'zen')

		expect(zen.paths.map((path) => `${path.kind}:${pathProviderId(path)}`)).toEqual([
			'detected:zen',
			'credential:zen',
		])
		expect(rowNeedsChoice(zen)).toBe(true)
	})

	it('does not offer a key beside the key it already has', () => {
		// The other half of the same rule, and the one that keeps the common case
		// a single keystroke: a vendor whose credential discovery already hands
		// over has ONE way in, and entering another key is that way twice.
		const aKey: DetectedProvider = {
			entry: PROVIDER_REGISTRY.openrouter,
			source: { kind: 'env', envName: 'OPENROUTER_API_KEY' },
			apiKey: 'not-a-real-key',
			alternatives: [],
		}
		const rows = providerListRows([aKey])
		const openrouter = rowOf(rows, 'openrouter')

		expect(openrouter.paths.map((path) => path.kind)).toEqual(['detected'])
		expect(rowNeedsChoice(openrouter)).toBe(false)
	})

	it('counts a token in an environment variable as a session, the way the sign-in screen does', () => {
		// `signedInSubscriptionProviders` is the one place that decides this, and
		// it says an OAuth token in an environment variable is a signed-in
		// session. Reading it any other way here would make the two screens
		// disagree about the same machine — and the key would look like the same
		// way in as the session it is not.
		const token: DetectedProvider = {
			entry: PROVIDER_REGISTRY['anthropic'],
			source: { kind: 'env', envName: 'CLAUDE_CODE_OAUTH_TOKEN' },
			apiKey: 'a-session-token',
			alternatives: [],
		}
		const rows = providerListRows([token])

		expect(rowOf(rows, 'anthropic').paths.map((path) => path.kind)).toEqual([
			'detected',
			'credential',
		])
	})

	it('asks nothing when the key it found is the only way in', () => {
		const key: DetectedProvider = {
			entry: PROVIDER_REGISTRY['anthropic'],
			source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
			apiKey: 'not-a-real-key',
			alternatives: [],
		}

		expect(providerListRows([key]).find((row) => row.vendor === 'anthropic')?.paths).toHaveLength(1)
	})

	it('keeps a vendor this build cannot construct visible, and unusable', () => {
		// A discovery that genuinely happened is not hidden by a build that cannot
		// use it: the row stays, says so in its source column, and refuses when
		// accepted.
		const rows = providerListRows([LOCAL_LMSTUDIO])
		const lmstudio = rowOf(rows, 'lmstudio')

		expect(lmstudio.detected).toHaveLength(1)
		expect(rowIsUsable(lmstudio)).toBe(false)
	})
})

describe('the ways in a vendor offers', () => {
	it('offers no key to a vendor that takes none, and no sign-in it does not have', () => {
		// Read off the registry's own flags rather than assumed from the id: a
		// vendor whose only member signs in must not advertise a field that would
		// be built for a credential it never reads, and one whose only member takes
		// a key must not advertise a sign-in nobody can start.
		const subscriptionOnly = vendorPaths([PROVIDER_REGISTRY.codex], [], true)
		expect(subscriptionOnly.map((path) => path.kind)).toEqual(['sign-in'])
		expect(subscriptionOnly.every((path) => pathProviderId(path) === 'codex')).toBe(true)

		const keyOnly = vendorPaths([PROVIDER_REGISTRY.deepseek], [], true)
		expect(keyOnly.map((path) => path.kind)).toEqual(['credential'])
		expect(keyOnly.every((path) => pathProviderId(path) === 'deepseek')).toBe(true)
	})

	it('leaves the sign-in out once the vendor already works', () => {
		// A sign-in is how a vendor with nothing becomes usable, and `l` offers it
		// from every screen. Listed a second time here it would stop every
		// operator whose key works to ask a question they have to decline — and
		// the answer would be the same one every launch.
		const keyWorks: DetectedProvider = {
			entry: PROVIDER_REGISTRY['openai'],
			source: { kind: 'env', envName: 'OPENAI_API_KEY' },
			apiKey: 'not-a-real-key',
			alternatives: [],
		}
		const entries = [PROVIDER_REGISTRY.codex, PROVIDER_REGISTRY['openai']]

		expect(vendorPaths(entries, [keyWorks], true).map((path) => path.kind)).toEqual(['detected'])
		// Nothing usable, so both ways to set it up are on the row.
		expect(vendorPaths(entries, [], true).map((path) => path.kind)).toEqual([
			'credential',
			'sign-in',
		])
	})

	it('offers nothing that cannot be built, and nothing already detected', () => {
		const lmstudio = vendorPaths([PROVIDER_REGISTRY.lmstudio], [LOCAL_LMSTUDIO], true)

		expect(lmstudio).toEqual([])
		expect(
			vendorPaths([PROVIDER_REGISTRY.ollama], [LOCAL_OLLAMA], true).map((p) => p.kind),
		).toEqual(['detected'])
	})

	it('offers the key beside the session discovery found for a vendor with its own', () => {
		// `google` declares a typed credential and no sign-in of its own, and
		// discovery reports the session its CLI keeps as a session. Two ways again,
		// from one id, and the row has to say both rather than choosing for the
		// operator.
		const rows = providerListRows([GEMINI_SESSION])
		const google = rowOf(rows, 'google')

		expect(google.paths.map((path) => `${path.kind}:${pathProviderId(path)}`)).toEqual([
			'detected:google',
			'credential:google',
		])
		expect(rowNeedsChoice(google)).toBe(true)
	})

	it('drops the ways in that only make sense on a screen of usable sessions', () => {
		const keyEntry = PROVIDER_REGISTRY['openai']

		expect(vendorPaths([keyEntry], [], false)).toEqual([])
		expect(vendorPaths([keyEntry], [CODEX_DEVICE], false).map((p) => p.kind)).toEqual(['detected'])
	})
})

describe('what a row says is missing', () => {
	it('says a key is optional where the free catalogue works without one', () => {
		// `requiresApiKey` is the registry's own answer to this, and a row that
		// said "needs" about a provider whose free models work would send an
		// operator looking for a credential they do not have to find.
		expect(credentialNeed(PROVIDER_REGISTRY.zen)).toBe('OPENCODE_API_KEY optional')
		expect(credentialNeed(PROVIDER_REGISTRY.google)).toBe('needs GEMINI_API_KEY')
	})

	it('prints a sentence rather than "needs undefined" for an entry with no variable', () => {
		const entry: ProviderRegistryEntry = {
			...PROVIDER_REGISTRY['openai'],
			envVars: [],
		}

		expect(credentialNeed(entry)).toBe('needs a credential')
	})
})

describe('the entries a vendor is made of', () => {
	it('derives membership from the registry field, in registry order', () => {
		expect(providerEntriesOfVendor('openai').map((entry) => entry.id)).toEqual(['codex', 'openai'])
		expect(providerEntriesOfVendor('anthropic').map((entry) => entry.id)).toEqual(['anthropic'])
	})

	it('covers every provider, so none falls outside the grouping', () => {
		const grouped = ALL_PROVIDER_IDS.flatMap((id) =>
			providerEntriesOfVendor(PROVIDER_REGISTRY[id].vendor).map((entry) => entry.id),
		)

		expect(new Set(grouped)).toEqual(new Set(ALL_PROVIDER_IDS))
	})
})

describe('which provider a row acts on', () => {
	it('resolves any id of a vendor to that vendor’s row', () => {
		const rows = providerListRows([CODEX_DEVICE, LOCAL_OLLAMA])

		expect(rowIndexOfProvider(rows, 'codex')).toBe(rowIndexOfProvider(rows, 'openai'))
		expect(rowIndexOfProvider(rows, 'not-a-provider')).toBe(-1)
		expect(rowIndexOfProvider(rows, null)).toBe(-1)
	})

	it('takes a typed credential for the vendor’s own provider', () => {
		// `k` asks the row, and the row answers with the provider whose credential
		// it can take — the session's vendor answers with its key provider, and a
		// local server answers with nothing.
		const rows = providerListRows([CODEX_DEVICE, LOCAL_OLLAMA])

		expect(typedCredentialEntry(rowOf(rows, 'codex'))?.id).toBe('openai')
		expect(typedCredentialEntry(rowOf(rows, 'ollama'))).toBeUndefined()
		expect(typedCredentialEntry(undefined)).toBeUndefined()
	})
})

describe('where the cursor starts', () => {
	const rows = providerListRows([LOCAL_OLLAMA])

	it('starts on the provider in force', () => {
		expect(initialProviderRow(rows, 'ollama', null)).toBe(0)
		expect(initialProviderRow(rows, 'openrouter', null)).toBe(
			rowIndexOfProvider(rows, 'openrouter'),
		)
	})

	it('starts on the provider the picker was opened for, when it was not detected', () => {
		// The saved provider with no credential is not on the machine, so it is
		// not in `detected`, so this used to fall through to row 1: the screen
		// said "No credential found" for the saved provider while the cursor sat elsewhere,
		// and `k` acted on whatever was highlighted.
		expect(initialProviderRow(rows, null, 'openrouter')).toBe(
			rowIndexOfProvider(rows, 'openrouter'),
		)
	})

	it('starts at the top when it knows neither, and never out of range', () => {
		expect(initialProviderRow(rows, null, null)).toBe(0)
		expect(initialProviderRow(rows, 'not-a-provider', null)).toBe(0)
		expect(initialProviderRow([], null, null)).toBe(0)
	})
})
