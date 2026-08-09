/**
 * OAuth token refresh for a subscription credential.
 *
 * A subscription access token is short-lived (~8h). When it lapses the
 * provider answers 401 and the agent stream dies. Refreshing proactively
 * against the token endpoint, using the long-lived refresh token, renews a
 * stale token before the session starts instead of surfacing it as an
 * authentication error.
 *
 * Non-throwing: any failure (no refresh token, network down, endpoint error)
 * returns the existing token unchanged — at worst the caller hits the same
 * 401 it would have hit anyway, never a crash.
 *
 * ## Where a refreshed token is written back
 *
 * There are two places a subscription credential can live and they are not
 * interchangeable, so `origin` says which one this credential came from and
 * the refreshed value goes back to the same place:
 *
 *  - `'stored'` — namzu's own store, written by the login flow, present on
 *    every platform.
 *  - `'keychain'` — a co-installed tool's macOS entry, which namzu reads but
 *    does not own.
 *
 * `origin` is optional and defaults to `'keychain'` because that is the only
 * source that existed when this file was written, and a caller compiled
 * against the old shape must keep behaving as it did. Every namzu-owned
 * caller passes it explicitly; a credential that came from the login flow and
 * was written back to the Keychain would be a no-op off macOS, leaving the
 * real store holding a token that is refreshed again on every launch.
 */

import {
	readStoredSubscriptionCredential,
	writeStoredSubscriptionCredential,
} from './credential-store.js'
import { OAUTH_CLIENT_ID, OAUTH_TOKEN_URL } from './identity.js'
import {
	type AgentOAuthCredential,
	readAgentKeychainCredential,
	writeAgentKeychainCredential,
} from './keychain.js'

/** Refresh a few seconds early so an about-to-expire token isn't used. */
const EXPIRY_SKEW_MS = 60_000

/**
 * Re-read the current credential from the store it lives in.
 *
 * The session layer calls this between turns because another process may
 * have rotated the token since launch. Pairing it with `origin` is what stops
 * a long-running session reading one store and writing the other.
 */
export function readSubscriptionCredential(origin: CredentialOrigin): AgentOAuthCredential | null {
	return origin === 'stored' ? readStoredSubscriptionCredential() : readAgentKeychainCredential()
}

/** Which store a subscription credential came from, and goes back to. */
export type CredentialOrigin = 'stored' | 'keychain'

export interface OAuthMetadata {
	readonly refreshToken?: string
	readonly expiresAt?: number
	/** Defaults to `'keychain'` — see the note at the top of this file. */
	readonly origin?: CredentialOrigin
}

/**
 * Return a non-expired access token, refreshing first if the current one is
 * lapsed/about-to-lapse and a refresh token is available. On a successful
 * refresh the new credential is persisted back to its own store (best-effort).
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
	persistRefreshed(refreshed, oauth.origin ?? 'keychain')
	return refreshed.accessToken
}

/**
 * Write a refreshed credential back to the store it came from.
 *
 * Best-effort in both arms, and for the same reason the refresh itself is:
 * the token is already in hand and usable for this session, so a store that
 * will not take it costs a re-refresh next launch, not the session.
 */
function persistRefreshed(cred: AgentOAuthCredential, origin: CredentialOrigin): void {
	if (origin === 'keychain') {
		writeAgentKeychainCredential(cred)
		return
	}
	try {
		writeStoredSubscriptionCredential(cred)
	} catch {
		// The store refused to prove the file private and therefore wrote
		// nothing. Deliberately silent: the message would be about a file, on
		// a path the operator did not ask about, in the middle of a turn.
	}
}

/** Exchange a refresh token for a new credential, or `null` on any failure. */
export async function refreshAgentOAuthToken(
	refreshToken: string,
): Promise<AgentOAuthCredential | null> {
	try {
		const res = await fetch(OAUTH_TOKEN_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: OAUTH_CLIENT_ID,
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
