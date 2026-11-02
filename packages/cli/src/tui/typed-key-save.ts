/**
 * Where a pasted API key goes once its provider session has opened.
 *
 * Every provider that takes a typed key is kept the same way: written to the
 * private store discovery reads on the next start (Gemini keeps its older
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
	readStoredApiKey,
	readStoredGeminiApiKey,
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

/**
 * A key added through `/auth` also becomes the provider's startup key when the
 * provider has none yet, so the provider list finds it next time. A key aimed
 * at a custom endpoint, a second key for a provider, and subscription tokens
 * stay in the account alone. Never throws: the account is already saved.
 */
export function keepAccountKeyForStartup(
	provider: string,
	apiKey: string,
	baseUrl: string | undefined,
	home?: string,
): TypedKeySave | null {
	if (baseUrl !== undefined) return null
	const entry = PROVIDER_REGISTRY[provider as ProviderId]
	if (!entry?.constructible || !entry.acceptsTypedCredential) return null
	const has =
		provider === 'google' ? readStoredGeminiApiKey(home) : readStoredApiKey(provider, home)
	if (has !== null) return null
	try {
		return saveTypedKey(entry.id, apiKey, home)
	} catch {
		return null
	}
}
