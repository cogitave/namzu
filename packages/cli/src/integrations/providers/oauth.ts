/**
 * Claude Code OAuth token refresh.
 *
 * The access token discovered from the macOS Keychain (or a clawtool secret)
 * is short-lived (~8h). When it lapses, Anthropic answers 401 and the agent
 * stream dies. Claude Code refreshes proactively against its public OAuth
 * token endpoint using the long-lived refresh token; we do the same so a
 * stale token is silently renewed before the session starts instead of
 * surfacing as an authentication error.
 *
 * Non-throwing: any failure (no refresh token, network down, endpoint error)
 * returns the existing token unchanged — at worst the caller hits the same
 * 401 it would have hit anyway, never a crash.
 */

import { type ClaudeCodeOAuthCredential, writeClaudeCodeKeychainCredential } from './keychain.js'

/** Public Claude Code OAuth client id + token endpoint. */
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

	const refreshed = await refreshClaudeCodeToken(oauth.refreshToken)
	if (!refreshed) return accessToken
	writeClaudeCodeKeychainCredential(refreshed)
	return refreshed.accessToken
}

/** Exchange a refresh token for a new credential, or `null` on any failure. */
export async function refreshClaudeCodeToken(
	refreshToken: string,
): Promise<ClaudeCodeOAuthCredential | null> {
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
