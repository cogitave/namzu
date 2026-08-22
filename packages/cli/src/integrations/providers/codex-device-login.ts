/** Namzu-owned ChatGPT/Codex device authorization for machines without Codex installed. */

import { writeStoredCodexCredential } from './credential-store.js'
import { type CodexOAuthCredential, codexCredentialFromTokens } from './harness-credentials.js'

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_AUTH_ORIGIN = 'https://auth.openai.com'

export type CodexDeviceLoginOutcome =
	| {
			readonly ok: true
			readonly credential: CodexOAuthCredential
			readonly storedAt: string
	  }
	| { readonly ok: false; readonly reason: string }

export interface CodexDeviceLogin {
	readonly url: string
	readonly userCode: string
	waitForCompletion(): Promise<CodexDeviceLoginOutcome>
	cancel(): void
}

export interface CodexDeviceLoginOptions {
	readonly home?: string
	readonly fetch?: typeof fetch
	readonly signal?: AbortSignal
	readonly authOrigin?: string
	readonly pollTimeoutMs?: number
}

interface UserCodeResponse {
	readonly deviceAuthId: string
	readonly userCode: string
	readonly intervalMs: number
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

async function parseJson(
	response: Response,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	const value = asRecord(await withSignal(response.json(), signal))
	if (!value) throw new Error('The sign-in service returned an invalid response.')
	return value
}

async function requestUserCode(
	fetchFn: typeof fetch,
	origin: string,
	signal: AbortSignal,
): Promise<UserCodeResponse> {
	const response = await withSignal(
		fetchFn(`${origin}/api/accounts/deviceauth/usercode`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
			},
			body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
			signal,
		}),
		signal,
	)
	if (!response.ok) {
		throw new Error(
			`The Codex device sign-in service refused the request (HTTP ${response.status}).`,
		)
	}
	const body = await parseJson(response, signal)
	const deviceAuthId = body.device_auth_id
	const userCode = body.user_code ?? body.usercode
	const seconds = Number(body.interval)
	if (
		typeof deviceAuthId !== 'string' ||
		deviceAuthId.length === 0 ||
		typeof userCode !== 'string' ||
		userCode.length === 0 ||
		!Number.isFinite(seconds) ||
		seconds < 0
	) {
		throw new Error('The Codex device sign-in service returned an incomplete response.')
	}
	return { deviceAuthId, userCode, intervalMs: Math.max(10, seconds * 1_000) }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await withSignal(
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, ms)
			}),
			signal,
		)
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

async function complete(
	code: UserCodeResponse,
	options: CodexDeviceLoginOptions,
	signal: AbortSignal,
): Promise<CodexDeviceLoginOutcome> {
	const fetchFn = options.fetch ?? globalThis.fetch
	const origin = (options.authOrigin ?? CODEX_AUTH_ORIGIN).replace(/\/$/, '')
	const deadlineAt = Date.now() + (options.pollTimeoutMs ?? 15 * 60_000)
	let authorization: Record<string, unknown> | null = null
	while (Date.now() < deadlineAt) {
		signal.throwIfAborted()
		const response = await withSignal(
			fetchFn(`${origin}/api/accounts/deviceauth/token`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json',
				},
				body: JSON.stringify({
					device_auth_id: code.deviceAuthId,
					user_code: code.userCode,
				}),
				signal,
			}),
			signal,
		)
		if (response.ok) {
			authorization = await parseJson(response, signal)
			break
		}
		if (response.status !== 403 && response.status !== 404) {
			return {
				ok: false,
				reason: `The Codex device sign-in was refused (HTTP ${response.status}). Nothing was stored.`,
			}
		}
		await delay(code.intervalMs, signal)
	}
	if (!authorization) {
		return {
			ok: false,
			reason: 'The Codex device code expired. Nothing was stored.',
		}
	}
	const authorizationCode = authorization.authorization_code
	const verifier = authorization.code_verifier
	if (
		typeof authorizationCode !== 'string' ||
		authorizationCode.length === 0 ||
		typeof verifier !== 'string' ||
		verifier.length === 0
	) {
		return {
			ok: false,
			reason: 'The Codex device sign-in returned no exchange code. Nothing was stored.',
		}
	}

	const redirectUri = `${origin}/deviceauth/callback`
	const form = new URLSearchParams({
		grant_type: 'authorization_code',
		code: authorizationCode,
		redirect_uri: redirectUri,
		client_id: CODEX_OAUTH_CLIENT_ID,
		code_verifier: verifier,
	})
	const exchanged = await withSignal(
		fetchFn(`${origin}/oauth/token`, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json',
			},
			body: form.toString(),
			signal,
		}),
		signal,
	)
	if (!exchanged.ok) {
		return {
			ok: false,
			reason: `The Codex token exchange was refused (HTTP ${exchanged.status}). Nothing was stored.`,
		}
	}
	const tokens = await parseJson(exchanged, signal)
	const accessToken = tokens.access_token
	const refreshToken = tokens.refresh_token
	const credential =
		typeof accessToken === 'string'
			? codexCredentialFromTokens({
					accessToken,
					...(typeof refreshToken === 'string' ? { refreshToken } : {}),
				})
			: null
	if (!credential) {
		return {
			ok: false,
			reason: 'The Codex token exchange did not identify an account. Nothing was stored.',
		}
	}
	signal.throwIfAborted()
	try {
		const storedAt = writeStoredCodexCredential(credential, options.home)
		return { ok: true, credential, storedAt }
	} catch (error) {
		return {
			ok: false,
			reason: `Signed in to Codex, but the credential could not be stored privately: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}

export async function beginCodexDeviceLogin(
	options: CodexDeviceLoginOptions = {},
): Promise<CodexDeviceLogin> {
	options.signal?.throwIfAborted()
	const owner = new AbortController()
	const signal = options.signal ? AbortSignal.any([options.signal, owner.signal]) : owner.signal
	const origin = (options.authOrigin ?? CODEX_AUTH_ORIGIN).replace(/\/$/, '')
	const userCode = await requestUserCode(options.fetch ?? globalThis.fetch, origin, signal)
	let completion: Promise<CodexDeviceLoginOutcome> | undefined
	return {
		url: `${origin}/codex/device`,
		userCode: userCode.userCode,
		waitForCompletion: () => {
			completion ??= complete(userCode, options, signal).catch((error) => {
				if (signal.aborted) {
					return {
						ok: false,
						reason: 'The Codex sign-in was cancelled. Nothing was stored.',
					}
				}
				return {
					ok: false,
					reason: `Could not complete Codex sign-in: ${error instanceof Error ? error.message : String(error)}`,
				}
			})
			return completion
		},
		cancel: () => owner.abort(new Error('The Codex sign-in attempt was cancelled.')),
	}
}
