/**
 * OAuth token refresh for a subscription credential.
 *
 * A subscription access token is short-lived (~8h). When it lapses the
 * provider answers 401 and the agent stream dies. Refreshing proactively
 * against the token endpoint, using the long-lived refresh token, renews a
 * stale token before the session starts instead of surfacing it as an
 * authentication error.
 *
 * Best-effort for transient refresh failures: no refresh token, a network
 * failure, an ordinary endpoint refusal or the private deadline all return the
 * existing token. `invalid_grant` is different: the authorization grant is no
 * longer usable, so sending the expired access token or retrying the same
 * refresh on every turn cannot recover. It is a typed refusal. Caller
 * cancellation also escapes with its exact cause.
 *
 * ## Where a refreshed token is written back
 *
 * There are three places a subscription credential can live and they are not
 * interchangeable, so `origin` says which one this credential came from and
 * therefore which publication rule applies:
 *
 *  - `'stored'` — namzu's own store, written by the login flow, present on
 *    every platform. A refresh replaces only the exact credential it used.
 *  - `'keychain'` — a co-installed tool's macOS entry, which namzu reads but
 *    does not own. A refresh is session-local and never writes that entry.
 *  - `'claude-file'` — Claude's device-session file. A rotating refresh grant
 *    must publish its successor back to the exact admitted file or it would
 *    log the owner out, so publication preserves Claude's full envelope.
 *
 * `origin` is optional and defaults to `'keychain'` because that is the only
 * source that existed when this file was written. Every namzu-owned caller
 * passes it explicitly; a credential from the login flow misclassified as
 * Keychain-origin would remain stale on disk and refresh again on every
 * launch.
 */

import { buildProbeContext, probe } from '@namzu/sdk'

import { SUBSCRIPTION_CREDENTIAL_REF } from './credential-provider.js'
import {
	credentialsPath,
	readStoredSubscriptionCredential,
	replaceStoredSubscriptionCredential,
} from './credential-store.js'
import { readClaudeCredentialFile, replaceClaudeCredentialFile } from './harness-credentials.js'
import { OAUTH_CLIENT_ID, OAUTH_SCOPES, OAUTH_TOKEN_URL } from './identity.js'
import { type AgentOAuthCredential, readAgentKeychainCredential } from './keychain.js'

/** Refresh a few seconds early so an about-to-expire token isn't used. */
const EXPIRY_SKEW_MS = 60_000

/** One refresh request, including its response body, may hold a caller this long. */
const REFRESH_DEADLINE_MS = 30_000

class RefreshDeadlineError extends Error {
	constructor() {
		super(`The token endpoint did not answer within ${REFRESH_DEADLINE_MS}ms.`)
		this.name = 'RefreshDeadlineError'
	}
}

/**
 * Settle independently of a foreign promise that may ignore its signal.
 *
 * Passing `signal` to fetch is cooperative. This race is the host-owned
 * boundary that makes cancellation and the refresh deadline true even for a
 * custom transport or response body that never settles.
 */
async function awaitWithSignal<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted()
	let rejectAbort: (reason: unknown) => void = () => {}
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
	const onAbort = () => rejectAbort(signal.reason)
	signal.addEventListener('abort', onAbort, { once: true })
	if (signal.aborted) onAbort()
	try {
		return await Promise.race([operation, aborted])
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
}

/**
 * Re-read the current credential from the store it lives in.
 *
 * The session layer calls this between turns because another process may have
 * rotated the token since launch. Pairing it with `origin` is what stops a
 * long-running session reading one store and writing the other.
 *
 * **It takes an origin rather than searching, and that is the point.** A
 * version that tried both and returned the first hit would look more helpful
 * and would silently break the pairing: a session that started on namzu's own
 * credential would, on the machine where both exist, quietly begin refreshing
 * a co-installed tool's credential instead — writing namzu's refreshed token
 * into somebody else's envelope, and leaving the store the operator actually
 * signed into holding a token that lapses again on every launch.
 *
 * One credential, one store, for its whole life. `discover.ts` decides which
 * at detection; everything after that is told, not asked.
 */
export function readSubscriptionCredential(
	origin: CredentialOrigin,
	sourcePath?: string,
): AgentOAuthCredential | null {
	if (origin === 'stored') return readStoredSubscriptionCredential()
	if (origin === 'claude-file') {
		return sourcePath ? readClaudeCredentialFile(sourcePath) : null
	}
	return readAgentKeychainCredential()
}

/** Which store a subscription credential came from and therefore who owns publication. */
export type CredentialOrigin = 'stored' | 'keychain' | 'claude-file'

export interface OAuthMetadata {
	readonly refreshToken?: string
	readonly expiresAt?: number
	readonly scopes?: readonly string[]
	/** Defaults to `'keychain'` — see the note at the top of this file. */
	readonly origin?: CredentialOrigin
	/** Exact owner file admitted by discovery; required for `'claude-file'`. */
	readonly sourcePath?: string
}

/** The credential that authorized a refresh was removed before publication. */
export class CredentialWithdrawnError extends Error {
	override readonly name = 'CredentialWithdrawnError'

	constructor(message = 'The subscription credential was removed while it was being refreshed.') {
		super(message)
	}
}

/** The store could not prove whether the refresh still owned publication. */
export class CredentialPublicationError extends Error {
	override readonly name = 'CredentialPublicationError'

	constructor(options?: ErrorOptions) {
		super('The refreshed subscription credential could not be published safely.', options)
	}
}

/** The authorization server says this exact refresh grant cannot be used again. */
export class CredentialRefreshRejectedError extends Error {
	override readonly name = 'CredentialRefreshRejectedError'
	readonly code = 'invalid_grant' as const

	constructor() {
		super('The subscription refresh token is no longer usable. Sign in again with /login.')
	}
}

/**
 * Return a non-expired access token, refreshing first if the current one is
 * lapsed/about-to-lapse and a refresh token is available. On a successful
 * refresh a Namzu-owned credential is conditionally persisted. A borrowed
 * Keychain credential is used only in memory because its owner cannot
 * participate in our conditional-write boundary.
 */
export async function ensureFreshAnthropicToken(
	accessToken: string,
	oauth: OAuthMetadata,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted()
	const fresh = oauth.expiresAt === undefined || oauth.expiresAt - Date.now() > EXPIRY_SKEW_MS
	if (fresh) return accessToken
	if (!oauth.refreshToken) return accessToken

	const refreshed = await refreshAgentOAuthToken(oauth.refreshToken, signal, oauth.scopes)
	if (!refreshed) return accessToken
	// The response body was the final foreign await. Re-check immediately at
	// the durable boundary so a stopped run cannot rotate a credential later.
	signal?.throwIfAborted()
	const expected: AgentOAuthCredential = {
		accessToken,
		refreshToken: oauth.refreshToken,
		expiresAt: oauth.expiresAt,
		scopes: oauth.scopes,
	}
	return publishRefreshed(expected, refreshed, oauth.origin ?? 'keychain', oauth.sourcePath)
		.accessToken
}

/**
 * Say that a credential turned over, without saying what it turned into.
 *
 * Through the probe registry that already carries `vault_lookup`, because a
 * second bus means a subscriber that sees lookups and not rotations, or the
 * reverse, depending on which one it happened to find.
 */
function announceRotation(replaced: boolean): void {
	probe.dispatch(
		{
			type: 'vault_credential_changed',
			kind: replaced ? 'rotated' : 'set',
			source: credentialsPath(),
			// The NAME. This event exists to be logged and retained, which is
			// exactly what the value must not be.
			ref: SUBSCRIPTION_CREDENTIAL_REF,
		},
		buildProbeContext(),
	)
}

function publishRefreshed(
	expected: AgentOAuthCredential,
	refreshed: AgentOAuthCredential,
	origin: CredentialOrigin,
	sourcePath?: string,
): AgentOAuthCredential {
	if (origin === 'keychain') {
		// This entry belongs to another product, whose writer cannot participate
		// in a Namzu lock or conditional update. Never overwrite it. A rotation
		// that landed while the request was pending wins for this session; when it
		// is unchanged, the refreshed token remains session-local.
		const current = readAgentKeychainCredential()
		if (!current) throw new CredentialWithdrawnError()
		return !sameOAuthCredential(current, expected) ? current : refreshed
	}
	if (origin === 'claude-file') {
		if (!sourcePath) throw new CredentialPublicationError()
		let result: ReturnType<typeof replaceClaudeCredentialFile>
		try {
			result = replaceClaudeCredentialFile(sourcePath, expected, refreshed)
		} catch (error) {
			throw new CredentialPublicationError({ cause: error })
		}
		if (!result.replaced) {
			if (!result.current) throw new CredentialWithdrawnError()
			return result.current
		}
		return refreshed
	}
	let result: ReturnType<typeof replaceStoredSubscriptionCredential>
	try {
		result = replaceStoredSubscriptionCredential(expected, refreshed)
	} catch (error) {
		// A busy lock may be an external rotation in progress. Falling back to
		// A' here would turn a failed CAS into permission to ignore its winner.
		throw new CredentialPublicationError({ cause: error })
	}
	if (!result.replaced) {
		if (!result.current) throw new CredentialWithdrawnError()
		return result.current
	}
	// Announced only after the store proved the file private. A rotation event
	// for a write that refused would have a reader chasing a turn-over that
	// never happened. Probe failure is observability failure, not permission to
	// undo a credential that is already durably committed.
	try {
		announceRotation(refreshed.accessToken !== undefined)
	} catch {
		// The credential is already committed. Telemetry cannot roll it back.
	}
	return refreshed
}

/** Exact credential identity used by refresh publication and the live-session refusal cache. */
export function sameOAuthCredential(
	left: AgentOAuthCredential,
	right: AgentOAuthCredential,
): boolean {
	if (
		left.accessToken !== right.accessToken ||
		left.refreshToken !== right.refreshToken ||
		left.expiresAt !== right.expiresAt
	) {
		return false
	}
	const leftScopes = left.scopes ?? []
	const rightScopes = right.scopes ?? []
	return (
		leftScopes.length === rightScopes.length &&
		leftScopes.every((scope, index) => scope === rightScopes[index])
	)
}

/**
 * Exchange a refresh token for a new credential.
 *
 * Transient/unclassified failures return `null`. A standards-defined
 * `400 invalid_grant` throws {@link CredentialRefreshRejectedError}; retrying
 * the same grant is not recovery.
 */
export async function refreshAgentOAuthToken(
	refreshToken: string,
	signal?: AbortSignal,
	scopes: readonly string[] = OAUTH_SCOPES.split(' '),
): Promise<AgentOAuthCredential | null> {
	signal?.throwIfAborted()
	const requestController = new AbortController()
	const timeoutCause = new RefreshDeadlineError()
	const onCallerAbort = () => requestController.abort(signal?.reason)
	signal?.addEventListener('abort', onCallerAbort, { once: true })
	if (signal?.aborted) onCallerAbort()
	const timer = setTimeout(() => requestController.abort(timeoutCause), REFRESH_DEADLINE_MS)

	try {
		const res = await awaitWithSignal(
			fetch(OAUTH_TOKEN_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					grant_type: 'refresh_token',
					refresh_token: refreshToken,
					client_id: OAUTH_CLIENT_ID,
					scope: scopes.join(' '),
				}),
				signal: requestController.signal,
			}),
			requestController.signal,
		)
		signal?.throwIfAborted()
		if (!res.ok) {
			if (res.status === 400) {
				const failure = (await awaitWithSignal(res.json(), requestController.signal)) as {
					error?: unknown
				}
				if (typeof failure?.error === 'string' && failure.error.toLowerCase() === 'invalid_grant') {
					throw new CredentialRefreshRejectedError()
				}
			}
			return null
		}
		const data = (await awaitWithSignal(res.json(), requestController.signal)) as {
			access_token?: unknown
			refresh_token?: unknown
			expires_in?: unknown
			scope?: unknown
		}
		if (typeof data.access_token !== 'string' || data.access_token.length === 0) return null
		return {
			accessToken: data.access_token,
			refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken,
			expiresAt:
				typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1_000 : undefined,
			scopes: typeof data.scope === 'string' ? data.scope.split(' ').filter(Boolean) : [...scopes],
		}
	} catch (error) {
		if (error instanceof CredentialRefreshRejectedError) throw error
		// A cooperative transport may replace the request cause with a generic
		// AbortError. The fused controller is the first-cause latch: only a caller
		// reason that actually won is allowed to escape as cancellation. A later
		// caller abort cannot relabel the private deadline.
		if (signal?.aborted && requestController.signal.reason === signal.reason) {
			throw signal.reason
		}
		return null
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener('abort', onCallerAbort)
	}
}
