/** Read-only reuse of the Google account session owned by Gemini CLI. */
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { wslWindowsHome } from './harness-credentials.js'

const REFRESH_URL = 'https://oauth2.googleapis.com/token'
const MAX_BYTES = 1024 * 1024

export interface GeminiCredential {
	readonly accessToken: string
	readonly refreshToken?: string
	readonly expiresAt?: number
}

export function readGeminiCredentialFile(path: string): GeminiCredential | null {
	let fd: number | undefined
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
		const stat = fstatSync(fd)
		if (!stat.isFile() || stat.size > MAX_BYTES) return null
		const buffer = Buffer.alloc(MAX_BYTES + 1)
		let size = 0
		while (size < buffer.length) {
			const count = readSync(fd, buffer, size, buffer.length - size, null)
			if (count === 0) break
			size += count
		}
		if (size > MAX_BYTES) return null
		const value: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'))
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null
		const record = value as Record<string, unknown>
		if (typeof record.access_token !== 'string' || !record.access_token.trim()) return null
		if (
			record.expiry_date !== undefined &&
			(typeof record.expiry_date !== 'number' ||
				!Number.isFinite(record.expiry_date) ||
				record.expiry_date <= 0)
		)
			return null
		return {
			accessToken: record.access_token,
			...(typeof record.refresh_token === 'string' && record.refresh_token.trim()
				? { refreshToken: record.refresh_token }
				: {}),
			...(typeof record.expiry_date === 'number' ? { expiresAt: record.expiry_date } : {}),
		}
	} catch {
		return null
	} finally {
		if (fd !== undefined) closeSync(fd)
	}
}

export function readGeminiFileCredentialCandidates(
	home: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	windowsHome: string | null | undefined = home === undefined ? wslWindowsHome(env) : null,
): readonly { readonly path: string; readonly credential: GeminiCredential }[] {
	// Gemini CLI's Storage appends .gemini to its overridden home. An explicit
	// owner location must not fall through to a different signed-in account.
	const paths = env.GEMINI_CLI_HOME
		? [join(env.GEMINI_CLI_HOME, '.gemini', 'oauth_creds.json')]
		: [
				join(home ?? homedir(), '.gemini', 'oauth_creds.json'),
				...(windowsHome ? [join(windowsHome, '.gemini', 'oauth_creds.json')] : []),
			]
	return [...new Set(paths)].flatMap((path) => {
		const credential = readGeminiCredentialFile(path)
		return credential &&
			(credential.expiresAt === undefined ||
				credential.expiresAt > Date.now() + 60_000 ||
				credential.refreshToken)
			? [{ path, credential }]
			: []
	})
}

/** Refresh in memory only. Re-read the owner's file before every request so logout is respected. */
export function createGeminiAccessTokenResolver(
	path: string,
	fetchFn: typeof fetch = globalThis.fetch,
	env: NodeJS.ProcessEnv = process.env,
): (signal?: AbortSignal) => Promise<string> {
	let source: string | undefined
	let cached: GeminiCredential | undefined
	let pending: Promise<string> | undefined
	return async (signal) => {
		signal?.throwIfAborted()
		const owner = readGeminiCredentialFile(path)
		if (!owner)
			throw new Error('Gemini CLI sign-in is no longer available. Sign in with Gemini CLI again.')
		const fingerprint = JSON.stringify(owner)
		if (source !== fingerprint) {
			source = fingerprint
			cached = owner
			pending = undefined
		}
		const current = cached ?? owner
		if (current.expiresAt === undefined || current.expiresAt > Date.now() + 60_000)
			return current.accessToken
		if (!current.refreshToken)
			throw new Error('Gemini CLI sign-in has expired. Sign in with Gemini CLI again.')
		const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim()
		const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()
		if (!clientId || !clientSecret)
			throw new Error(
				'Gemini CLI sign-in has expired. Refresh it in Gemini CLI, or configure the matching GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
			)
		if (!pending) {
			const refresh = current.refreshToken
			const operation = (async () => {
				const response = await fetchFn(REFRESH_URL, {
					method: 'POST',
					redirect: 'error',
					signal: AbortSignal.timeout(15_000),
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						client_id: clientId,
						client_secret: clientSecret,
						refresh_token: refresh,
						grant_type: 'refresh_token',
					}),
				})
				if (!response.ok)
					throw new Error(
						`Gemini CLI sign-in could not be refreshed (HTTP ${response.status}). Sign in with Gemini CLI again.`,
					)
				const value = (await response.json()) as Record<string, unknown>
				if (
					typeof value.access_token !== 'string' ||
					!value.access_token ||
					typeof value.expires_in !== 'number' ||
					!Number.isFinite(value.expires_in) ||
					value.expires_in <= 0
				)
					throw new Error('Google returned an invalid sign-in refresh response.')
				// Do not let a late refresh replace a newer owner session.
				if (source === fingerprint)
					cached = {
						accessToken: value.access_token,
						refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : refresh,
						expiresAt: Date.now() + value.expires_in * 1000,
					}
				return value.access_token
			})()
			pending = operation
			void operation
				.finally(() => {
					if (pending === operation) pending = undefined
				})
				.catch(() => {})
		}
		if (!signal) return pending
		signal.throwIfAborted()
		// A cancelled waiter must not cancel a refresh needed by sibling requests.
		return new Promise<string>((resolve, reject) => {
			const abort = () => reject(signal.reason)
			signal.addEventListener('abort', abort, { once: true })
			pending?.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
		})
	}
}
