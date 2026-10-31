/** Refresh for a Codex credential owned by Namzu's credential store. */

import { CODEX_AUTH_ORIGIN, CODEX_OAUTH_CLIENT_ID } from './codex-device-login.js'
import {
	type StoredCodexCredential,
	readStoredCodexCredential,
	replaceStoredCodexCredential,
} from './credential-store.js'
import { type CodexOAuthCredential, codexCredentialFromTokens } from './harness-credentials.js'
import { CredentialPublicationError, CredentialWithdrawnError } from './oauth.js'

const REFRESH_WINDOW_MS = 5 * 60_000

export interface StoredCodexRefreshOptions {
	readonly home?: string
	readonly fetch?: typeof fetch
	readonly authOrigin?: string
	readonly now?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

async function withSignal<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted()
	let rejectAbort: (reason: unknown) => void = () => {}
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
	const onAbort = () => rejectAbort(signal.reason)
	signal.addEventListener('abort', onAbort, { once: true })
	try {
		return await Promise.race([operation, aborted])
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
}

/** True when `credential` should be refreshed before use. */
export function codexCredentialIsDue(
	credential: { readonly expiresAt?: number },
	now: number = Date.now(),
): boolean {
	return credential.expiresAt !== undefined && credential.expiresAt - now <= REFRESH_WINDOW_MS
}

/**
 * Spend `current`'s refresh grant at the authorization server and return the
 * successor, which must belong to the same ChatGPT account. Writes nothing:
 * the caller decides where the successor is published. Shared by the stored
 * credential and by a private per-account Codex home.
 */
export async function requestCodexRefresh(
	current: CodexOAuthCredential,
	signal: AbortSignal | undefined,
	options: Pick<StoredCodexRefreshOptions, 'fetch' | 'authOrigin'> = {},
): Promise<CodexOAuthCredential> {
	if (!current.refreshToken) {
		throw new CredentialWithdrawnError(
			'The Codex subscription expired without a refresh grant. Sign in again.',
		)
	}
	const deadline = AbortSignal.timeout(30_000)
	const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
	let response: Response
	try {
		response = await withSignal(
			(options.fetch ?? globalThis.fetch)(
				`${(options.authOrigin ?? CODEX_AUTH_ORIGIN).replace(/\/$/, '')}/oauth/token`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'application/json',
					},
					body: JSON.stringify({
						client_id: CODEX_OAUTH_CLIENT_ID,
						grant_type: 'refresh_token',
						refresh_token: current.refreshToken,
					}),
					signal: requestSignal,
				},
			),
			requestSignal,
		)
	} catch (error) {
		if (signal?.aborted) throw signal.reason
		throw new CredentialPublicationError({ cause: error })
	}
	if (!response.ok) {
		throw new CredentialWithdrawnError(
			`The Codex subscription could not be refreshed (HTTP ${response.status}). Sign in again.`,
		)
	}
	const body = asRecord(await withSignal(response.json(), requestSignal))
	if (!body) {
		throw new CredentialWithdrawnError(
			'The Codex refresh service returned an invalid credential. Sign in again.',
		)
	}
	const accessToken = body.access_token
	const refreshToken = body.refresh_token
	const refreshed =
		typeof accessToken === 'string'
			? codexCredentialFromTokens({
					accessToken,
					refreshToken: typeof refreshToken === 'string' ? refreshToken : current.refreshToken,
					accountId: current.accountId,
				})
			: null
	if (!refreshed || refreshed.accountId !== current.accountId) {
		throw new CredentialWithdrawnError(
			'The refreshed Codex credential did not belong to the signed-in account. Sign in again.',
		)
	}
	return refreshed
}

export async function ensureFreshStoredCodexCredential(
	signal?: AbortSignal,
	options: StoredCodexRefreshOptions = {},
): Promise<StoredCodexCredential> {
	signal?.throwIfAborted()
	const current = readStoredCodexCredential(options.home)
	if (!current) {
		throw new CredentialWithdrawnError(
			'The Codex subscription Namzu stored was removed. Sign in again or choose another provider.',
		)
	}
	if (
		current.expiresAt === undefined ||
		current.expiresAt - (options.now ?? Date.now()) > REFRESH_WINDOW_MS
	) {
		return current
	}
	if (!current.refreshToken) {
		throw new CredentialWithdrawnError(
			'The Codex subscription expired without a refresh grant. Sign in again.',
		)
	}
	const refreshed = await requestCodexRefresh(current, signal, options)
	signal?.throwIfAborted()
	let result: ReturnType<typeof replaceStoredCodexCredential>
	try {
		result = replaceStoredCodexCredential(current, refreshed, options.home)
	} catch (error) {
		throw new CredentialPublicationError({ cause: error })
	}
	if (!result.replaced) {
		if (!result.current) throw new CredentialWithdrawnError()
		return result.current
	}
	return refreshed
}
