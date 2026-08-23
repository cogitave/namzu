/**
 * Obtaining a subscription credential from inside namzu.
 *
 * namzu could already USE and REFRESH a plan-backed credential; it could not
 * get one. The only way in was to install another product, sign in there, and
 * let discovery borrow what that product had stored — which works on exactly
 * one operating system and requires the other product. This is the missing
 * half: an authorization-code exchange, run by namzu, that ends with a
 * credential in namzu's own store (`credential-store.ts`).
 *
 * ## The flow
 *
 * Authorization code with PKCE (RFC 7636, S256), redirected to the platform
 * callback registered for the owner client's public identity. The operator
 * copies the code — or the whole finished address — back to the initiating
 * surface. This flow deliberately does not invent a localhost redirect: the
 * authorization server rejects an unregistered callback before sign-in.
 *
 * ## What never happens here
 *
 * No token is logged, printed, or put in an error. Failures name the status,
 * the endpoint and the stage; they never carry the response body, because a
 * token endpoint's body is where the token is. Nothing is written to the
 * store until an exchange has fully succeeded, so an abandoned or rejected
 * login leaves no partial credential behind.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { writeStoredSubscriptionCredential } from './credential-store.js'
import type { DetectedProvider } from './discover.js'
import {
	AUTHORIZE_URL,
	MANUAL_REDIRECT_URI,
	OAUTH_CLIENT_ID,
	OAUTH_SCOPES,
	OAUTH_TOKEN_URL,
} from './identity.js'
import type { AgentOAuthCredential } from './keychain.js'
import { PROVIDER_REGISTRY } from './registry.js'

/** What a completed attempt produced. Never carries a secret in `reason`. */
export type LoginOutcome =
	| {
			readonly ok: true
			/** The stored credential, so the caller can open a session without re-reading. */
			readonly credential: AgentOAuthCredential
			/** Where it landed, so a surface can say so without guessing the path. */
			readonly storedAt: string
	  }
	| { readonly ok: false; readonly reason: string }

export interface SubscriptionLogin {
	/** The page to open. Safe to print — it carries a challenge, never a secret. */
	readonly url: string
	readonly redirectUri: string
	/** Finish from a pasted redirect URL, `code#state`, or a bare code. */
	completeWithPastedCode(input: string): Promise<LoginOutcome>
	/** Withdraw the attempt. Safe to call twice, and safe to call after success. */
	cancel(): void
}

export interface SubscriptionLoginOptions {
	/** Override `homedir()` — tests, and an operator with a relocated home. */
	readonly home?: string
	/** Override the token-exchange transport (tests inject a stub). */
	readonly fetch?: typeof fetch
	/** Authority of the surface that started this attempt. */
	readonly signal?: AbortSignal
}

/**
 * Begin a login. Returns the page to open plus the paste-completion handle.
 *
 * Deliberately does NOT open a browser. Which of `open`, `xdg-open` or a
 * Windows protocol handler to spawn — and whether spawning anything is even
 * appropriate — is a property of the surface the operator is sitting in front
 * of, not of the protocol. A module that reached for a browser would be
 * unusable from the one place that most needs it: a machine that has none.
 */
export async function beginSubscriptionLogin(
	options: SubscriptionLoginOptions = {},
): Promise<SubscriptionLogin> {
	options.signal?.throwIfAborted()
	const cancelController = new AbortController()
	const attemptSignal = options.signal
		? AbortSignal.any([options.signal, cancelController.signal])
		: cancelController.signal
	const exchangeOptions: SubscriptionLoginOptions = {
		...options,
		signal: attemptSignal,
	}
	const verifier = base64Url(randomBytes(32))
	const challenge = base64Url(createHash('sha256').update(verifier).digest())
	// An independent value, not the verifier reused.
	//
	// Reusing the verifier as `state` is a thing implementations do, and it
	// undoes PKCE: `state` travels in the authorization URL, so the verifier
	// would sit in the address bar, the browser history and any referrer along
	// the way — and the secret PKCE exists to keep out of that URL is exactly
	// the verifier.
	const state = base64Url(randomBytes(16))

	const redirectUri = MANUAL_REDIRECT_URI

	let settled = false
	const exchangeOnce = async (code: string, seenState: string): Promise<LoginOutcome> => {
		if (settled) return { ok: false, reason: 'This login was already completed.' }
		if (!constantTimeEquals(seenState, state)) {
			return {
				ok: false,
				reason:
					'The sign-in did not come back with the value namzu sent, so it cannot be matched to this attempt. Nothing was stored. Start the login again.',
			}
		}
		settled = true
		return exchange(code, state, verifier, redirectUri, exchangeOptions)
	}

	return {
		url: authorizeUrl(challenge, state, redirectUri),
		redirectUri,
		completeWithPastedCode: async (input) => {
			const parsed = parsePastedInput(input)
			if (!parsed.code) {
				return {
					ok: false,
					reason:
						'That does not contain an authorization code. Paste the whole address the browser finished on, or the code it showed you.',
				}
			}
			return exchangeOnce(parsed.code, parsed.state ?? state)
		},
		cancel: () => {
			cancelController.abort(new Error('The sign-in attempt was cancelled.'))
		},
	}
}

/**
 * The detected-provider record a completed sign-in produces.
 *
 * Shaped exactly like a discovered one — the same shape `discoverProviders`
 * would return on the NEXT launch, having read the file this login just
 * wrote — so every downstream path treats it identically and nothing has to
 * learn that a session began with a login. It carries `origin: 'stored'`, so
 * the between-turn refresh writes back to the file rather than to a Keychain
 * this machine may not have.
 */
export function subscriptionDetectedProvider(
	credential: AgentOAuthCredential,
	storedAt: string,
): DetectedProvider {
	return {
		entry: PROVIDER_REGISTRY.anthropic,
		source: { kind: 'stored', path: storedAt },
		apiKey: credential.accessToken,
		oauth: {
			refreshToken: credential.refreshToken,
			expiresAt: credential.expiresAt,
			origin: 'stored',
		},
		alternatives: [],
	}
}

function authorizeUrl(challenge: string, state: string, redirectUri: string): string {
	const params = new URLSearchParams({
		code: 'true',
		client_id: OAUTH_CLIENT_ID,
		response_type: 'code',
		redirect_uri: redirectUri,
		scope: OAUTH_SCOPES,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state,
	})
	return `${AUTHORIZE_URL}?${params.toString()}`
}

/**
 * Bound a foreign promise even when its implementation ignores `signal`.
 *
 * Supplying an AbortSignal to fetch is only a cooperation request. A custom
 * transport or response body can keep its promise pending after abort, so the
 * caller also owns this independent settlement boundary.
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
 * Exchange the code, and store the result only once it is whole.
 *
 * The store write is the LAST thing. A response missing an access token, a
 * non-2xx, a transport failure and a malformed body all return before it, so
 * there is no path on which a failed login leaves a file behind.
 */
async function exchange(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
	options: SubscriptionLoginOptions,
): Promise<LoginOutcome> {
	const cancelled = (): LoginOutcome => ({
		ok: false,
		reason: 'The sign-in was cancelled before it could be stored. Nothing was stored.',
	})
	if (options.signal?.aborted) return cancelled()
	const fetchFn = options.fetch ?? globalThis.fetch
	const deadline = AbortSignal.timeout(30_000)
	const requestSignal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
	const timedOut = (): LoginOutcome => ({
		ok: false,
		reason: 'The sign-in service did not answer within 30 seconds. Nothing was stored.',
	})
	let res: Response
	try {
		res = await awaitWithSignal(
			fetchFn(OAUTH_TOKEN_URL, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json',
				},
				body: JSON.stringify({
					grant_type: 'authorization_code',
					client_id: OAUTH_CLIENT_ID,
					code,
					state,
					redirect_uri: redirectUri,
					code_verifier: verifier,
				}),
				signal: requestSignal,
			}),
			requestSignal,
		)
	} catch (err) {
		if (options.signal?.aborted) return cancelled()
		if (deadline.aborted) return timedOut()
		// The MESSAGE of a transport error is safe (a hostname, a timeout); the
		// body of a response is not, and there is none here.
		return {
			ok: false,
			reason: `Could not reach the sign-in service (${err instanceof Error ? err.message : String(err)}). Nothing was stored.`,
		}
	}
	if (options.signal?.aborted) return cancelled()
	if (!res.ok) {
		// The status, never the body. A token endpoint answers failures with a
		// document that can contain the very thing this module must not leak.
		return {
			ok: false,
			reason: `The sign-in service refused the exchange (HTTP ${res.status}). The code may have already been used, or expired. Nothing was stored.`,
		}
	}
	let data: {
		access_token?: unknown
		refresh_token?: unknown
		expires_in?: unknown
		scope?: unknown
	}
	try {
		data = (await awaitWithSignal(res.json(), requestSignal)) as typeof data
	} catch {
		if (options.signal?.aborted) return cancelled()
		if (deadline.aborted) return timedOut()
		return {
			ok: false,
			reason:
				'The sign-in service answered with something that is not a token. Nothing was stored.',
		}
	}
	if (options.signal?.aborted) return cancelled()
	if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
		return {
			ok: false,
			reason: 'The sign-in service answered without a token. Nothing was stored.',
		}
	}
	const credential: AgentOAuthCredential = {
		accessToken: data.access_token,
		...(typeof data.refresh_token === 'string' && data.refresh_token.length > 0
			? { refreshToken: data.refresh_token }
			: {}),
		...(typeof data.expires_in === 'number'
			? { expiresAt: Date.now() + data.expires_in * 1_000 }
			: {}),
		...(typeof data.scope === 'string'
			? { scopes: data.scope.split(' ').filter(Boolean) }
			: { scopes: OAUTH_SCOPES.split(' ') }),
	}
	let storedAt: string
	try {
		// The last foreign await was response-body parsing. Re-check ownership at
		// the durable boundary so a surface that withdrew the attempt cannot get
		// a credential file later. The synchronous write is the success terminal.
		if (options.signal?.aborted) return cancelled()
		storedAt = writeStoredSubscriptionCredential(credential, options.home)
	} catch (err) {
		// The store refused to prove the file private, so there is no file. Say
		// what happened; the credential is dropped with the process.
		return {
			ok: false,
			reason: `Signed in, but the credential could not be stored privately: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
	return { ok: true, credential, storedAt }
}

/**
 * Pull a code (and a state, when there is one) out of whatever got pasted.
 *
 * Four spellings reach this in practice: the full redirect address, its query
 * string alone, the `code#state` pair a consent screen offers for copying,
 * and a bare code. Anything else yields no code and is refused by the caller
 * — guessing at a fifth shape would send an arbitrary string to a token
 * endpoint as if it were an authorization code.
 */
export function parsePastedInput(input: string): {
	code?: string
	state?: string
} {
	const value = input.trim()
	if (value.length === 0) return {}

	if (/^https?:\/\//i.test(value)) {
		try {
			const url = new URL(value)
			return {
				code: url.searchParams.get('code') ?? undefined,
				state: url.searchParams.get('state') ?? undefined,
			}
		} catch {
			return {}
		}
	}
	if (value.includes('code=')) {
		const params = new URLSearchParams(value.replace(/^\?/, ''))
		return {
			code: params.get('code') ?? undefined,
			state: params.get('state') ?? undefined,
		}
	}
	if (value.includes('#')) {
		const [code, state] = value.split('#', 2)
		return { code: code || undefined, state: state || undefined }
	}
	// A bare code. Whitespace already ruled out by the trim + the checks above
	// only when it contained a separator, so reject an obviously-wrong paste
	// (a sentence, a wrapped line) rather than posting it.
	if (/\s/.test(value)) return {}
	return { code: value }
}

/**
 * Compare two opaque values without leaking their relationship through timing.
 *
 * `state` is compared, not a secret, so this is belt-and-braces — but the
 * cheap version of this comparison is `===`, and `===` on strings of equal
 * length is the shape that teaches the next person to write it for the
 * verifier too.
 */
function constantTimeEquals(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8')
	const right = Buffer.from(b, 'utf8')
	if (left.length !== right.length) return false
	return timingSafeEqual(left, right)
}

function base64Url(bytes: Buffer): string {
	return bytes.toString('base64url')
}
