/**
 * macOS Keychain reader for a co-installed agent CLI's OAuth credentials.
 *
 * That CLI keeps its credentials in the macOS login Keychain rather than a
 * flat file, under the generic-password service in {@link KEYCHAIN_SERVICE}
 * below — the exact name is there, in one place, because it is the address
 * of the data and an auditor has to be able to read it. The password value
 * is a JSON envelope:
 *
 *   { "claudeAiOauth": { "accessToken": "...", "refreshToken": "...",
 *                         "expiresAt": ..., "scopes": [...] } }
 *
 *  * Non-throwing — every failure (not-darwin, security not installed,
 * entry missing, payload malformed) returns `null` so discovery treats
 * the source as "not available" rather than crashing.
 */

import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'

/** The generic-password service this reads. The address, verbatim. */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials'

export interface AgentOAuthCredential {
	readonly accessToken: string
	readonly refreshToken?: string
	readonly expiresAt?: number
	readonly scopes?: readonly string[]
}

export function readAgentKeychainCredential(): AgentOAuthCredential | null {
	if (platform() !== 'darwin') return null

	let raw: string
	try {
		raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
			encoding: 'utf8',
			timeout: 5_000,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim()
	} catch {
		return null
	}
	if (raw.length === 0) return null

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const env = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
	if (typeof env !== 'object' || env === null) return null
	const oauth = env as Record<string, unknown>
	const accessToken = oauth.accessToken
	if (typeof accessToken !== 'string' || accessToken.length === 0) return null
	return {
		accessToken,
		refreshToken: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : undefined,
		expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
		scopes: Array.isArray(oauth.scopes)
			? (oauth.scopes.filter((s) => typeof s === 'string') as string[])
			: undefined,
	}
}

/**
 * Detect whether a credential value is an OAuth-style token
 * (must be sent via `Authorization: Bearer`) vs a console API key (sent
 * via `x-api-key`). Positively identifies by prefix; defaults to API-key when unsure.
 */
export function isAnthropicOAuthToken(value: string): boolean {
	if (value.startsWith('sk-ant-api')) return false // console API key
	if (value.startsWith('sk-ant-oat')) return true // OAuth setup token
	if (value.startsWith('eyJ')) return true // JWT
	if (value.startsWith('cc-')) return true // OAuth access token from the Keychain source
	return false
}
