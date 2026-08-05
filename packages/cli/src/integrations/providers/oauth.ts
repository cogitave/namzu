/**
 * OAuth token refresh for a discovered subscription credential.
 *
 * The access token discovered from the macOS Keychain
 * is short-lived (~8h). When it lapses the provider answers 401 and the
 * agent stream dies. Refreshing proactively against the public OAuth token
 * endpoint, using the long-lived refresh token, renews a stale token before
 * the session starts instead of surfacing it as an authentication error.
 *
 * Non-throwing: any failure (no refresh token, network down, endpoint error)
 * returns the existing token unchanged — at worst the caller hits the same
 * 401 it would have hit anyway, never a crash.
 */

import { type AgentOAuthCredential, writeAgentKeychainCredential } from './keychain.js'

/**
 * The public OAuth client id and token endpoint this credential was issued
 * against. Addresses, verbatim — the refresh only succeeds against these.
 */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'

/** Refresh a few seconds early so an about-to-expire token isn't used. */
const EXPIRY_SKEW_MS = 60_000

export interface OAuthMetadata {
	readonly refreshToken?: string
	readonly expiresAt?: number
}

/**
 * Return a non-expired access token, refreshing first if the current one is
 * lapsed/about-to-lapse and a refresh token is available. On a successful
 * refresh the new credential is persisted back to the Keychain (best-effort).
 */
export async function ensureFreshAnthropicToken(
	accessToken: string,
	oauth: OAuthMetadata,
): Promise<string> {
	const fresh = oauth.expiresAt === undefined || oauth.expiresAt - Date.now() > EXPIRY_SKEW_MS
	if (fresh) return accessToken
	if (!oauth.refreshToken) return accessToken

	const refreshed = await refreshAgentOAuthToken(oauth.refreshToken)
	if (!refreshed) return accessToken
	writeAgentKeychainCredential(refreshed)
	return refreshed.accessToken
}

/** Exchange a refresh token for a new credential, or `null` on any failure. */
export async function refreshAgentOAuthToken(
	refreshToken: string,
): Promise<AgentOAuthCredential | null> {
	try {
		const res = await fetch(TOKEN_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		})
		if (!res.ok) return null
		const data = (await res.json()) as {
			access_token?: unknown
			refresh_token?: unknown
			expires_in?: unknown
		}
		if (typeof data.access_token !== 'string' || data.access_token.length === 0) return null
		return {
			accessToken: data.access_token,
			refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken,
			expiresAt:
				typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1_000 : undefined,
		}
	} catch {
		return null
	}
}
