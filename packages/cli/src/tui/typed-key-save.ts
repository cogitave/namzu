/**
 * Where a pasted API key goes once its provider session has opened.
 *
 * Every provider that takes a typed key is kept the same way: written to the
 * private store discovery reads on the next start (the Google key keeps its older
 * file), so the key is asked for once. A pasted subscription token is the one
 * exception, because it lapses in hours with nothing to renew it; saving it
 * would turn a working launch into a 401 later.
 */

import {
	PROVIDER_REGISTRY,
	type ProviderId,
	apiKeyLogoutWord,
	apiKeysPath,
	googleApiKeyPath,
	writeStoredApiKey,
	writeStoredGeminiApiKey,
} from '../integrations/providers/index.js'
import { classifyCredential } from './credential-entry.js'

export type TypedKeySave =
	| { readonly kind: 'saved'; readonly path: string }
	| { readonly kind: 'session-only' }

/** The word `/logout` takes for this provider's saved key. */
export function logoutWordFor(id: ProviderId): string {
	return apiKeyLogoutWord(id)
}

export function saveTypedKey(id: ProviderId, apiKey: string, home?: string): TypedKeySave {
	const entry = PROVIDER_REGISTRY[id]
	if (classifyCredential(entry, apiKey) === 'subscription-token') return { kind: 'session-only' }
	if (id === 'google') {
		writeStoredGeminiApiKey(apiKey, home)
		return { kind: 'saved', path: googleApiKeyPath(...(home === undefined ? [] : [home])) }
	}
	writeStoredApiKey(id, apiKey, home)
	return { kind: 'saved', path: apiKeysPath(home) }
}
