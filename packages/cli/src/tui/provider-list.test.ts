/**
 * What the provider picker lists, and what it refuses to.
 *
 * The list is the whole feature and it is pure, so it is decided here rather
 * than through a rendered frame: which rows exist, in what order, and what each
 * one says is missing. The screen's side of it — that Enter on such a row opens
 * the credential field and hands the typed value up — is in
 * `__tests__/every-provider-you-can-set-up-is-on-the-list.test.tsx`.
 */

import { describe, expect, it } from 'vitest'

import {
	ALL_PROVIDER_IDS,
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type ProviderRegistryEntry,
} from '../integrations/providers/index.js'
import {
	credentialNeed,
	initialProviderRow,
	providerListRows,
	rowProviderId,
	settableProviders,
} from './provider-list.js'

const LOCAL_OLLAMA: DetectedProvider = {
	entry: PROVIDER_REGISTRY.ollama,
	source: { kind: 'probe', url: 'http://localhost:11434' },
	alternatives: [],
}

const FREE_ZEN: DetectedProvider = {
	entry: PROVIDER_REGISTRY.zen,
	source: { kind: 'public' },
	alternatives: [],
}

describe('the rows a picker draws', () => {
	it('keeps the detected rows first, in the order discovery produced them', () => {
		// Discovery sorts anonymous access last, and that order is the screen's
		// order. Appending is what keeps it: anything that merged the two groups
		// would move a row the operator has already learned the position of.
		const rows = providerListRows([FREE_ZEN, LOCAL_OLLAMA])

		expect(rows.slice(0, 2).map((row) => row.kind)).toEqual(['detected', 'detected'])
		expect(rows.slice(0, 2).map(rowProviderId)).toEqual(['zen', 'ollama'])
	})

	it('adds a provider nothing on this machine serves, named by the variable it needs', () => {
		// The defect this is written against: a saved provider with a key the
		// operator holds and has not exported appeared nowhere on the screen that
		// exists to choose a provider, so there was no row to select and no way to
		// type the key.
		const openrouter = providerListRows([LOCAL_OLLAMA]).find(
			(row) => rowProviderId(row) === 'openrouter',
		)

		expect(openrouter?.kind).toBe('unconfigured')
		expect(credentialNeed(PROVIDER_REGISTRY.openrouter)).toBe('needs OPENROUTER_API_KEY')
	})

	it('leaves out every provider this screen cannot set up', () => {
		// Asserted by NAME, so that a registry flag which flips turns this red
		// instead of silently adding or removing a row. Each omission has a
		// reason, and the reason is why the row would lead nowhere:
		//
		//  - `codex` needs a device-code sign-in, which this screen already offers
		//    with `l`; offering it here too would be two ways to set up one
		//    provider, one of which cannot take what the other asks for.
		//  - `ollama` needs a local server rather than a secret.
		//  - `lmstudio` is not constructible in this build at all.
		//  - `bedrock` needs an AWS credential chain (key, secret, region, or a
		//    role the SDK assumes), which one field cannot express.
		//  - `http` is an endpoint whose base URL is half the credential; a key
		//    with nowhere to send it is not a setup.
		const listed = new Set(providerListRows([]).map(rowProviderId))

		expect(ALL_PROVIDER_IDS.filter((id) => !listed.has(id))).toEqual([
			'codex',
			'ollama',
			'lmstudio',
			'bedrock',
			'http',
		])
	})

	it('lists nothing twice when a settable provider was also detected', () => {
		const rows = providerListRows([FREE_ZEN, LOCAL_OLLAMA])
		const ids = rows.map(rowProviderId)

		expect(ids).toHaveLength(new Set(ids).size)
		expect(ids.filter((id) => id === 'zen')).toHaveLength(1)
	})

	it('offers the detected rows alone where only usable sessions belong', () => {
		// The signed-in-subscription screen asks which session to use. A row that
		// needs a key first makes that sentence false.
		expect(providerListRows([FREE_ZEN], false).map(rowProviderId)).toEqual(['zen'])
	})

	it('derives what it can set up from the registry, never from a second list', () => {
		expect(settableProviders().map((entry) => entry.id)).toEqual(
			ALL_PROVIDER_IDS.filter(
				(id) => PROVIDER_REGISTRY[id].constructible && PROVIDER_REGISTRY[id].acceptsTypedCredential,
			),
		)
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

describe('where the cursor starts', () => {
	const rows = providerListRows([LOCAL_OLLAMA])

	it('starts on the provider in force', () => {
		expect(initialProviderRow(rows, 'ollama', null)).toBe(0)
		expect(initialProviderRow(rows, 'openrouter', null)).toBe(
			rows.findIndex((row) => rowProviderId(row) === 'openrouter'),
		)
	})

	it('starts on the provider the picker was opened for, when it was not detected', () => {
		// The saved provider with no credential is not on the machine, so it is
		// not in `detected`, so this used to fall through to row 1: the screen
		// said "No credential found" for the saved provider while the cursor sat elsewhere,
		// and `k` acted on whatever was highlighted.
		expect(initialProviderRow(rows, null, 'openrouter')).toBe(
			rows.findIndex((row) => rowProviderId(row) === 'openrouter'),
		)
	})

	it('starts at the top when it knows neither, and never out of range', () => {
		expect(initialProviderRow(rows, null, null)).toBe(0)
		expect(initialProviderRow(rows, 'not-a-provider', null)).toBe(0)
		expect(initialProviderRow([], null, null)).toBe(0)
	})
})
