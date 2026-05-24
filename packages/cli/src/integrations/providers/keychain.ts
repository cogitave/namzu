/**
 * macOS Keychain reader for Claude Code OAuth credentials.
 *
 * Claude Code stores its OAuth credentials in the macOS login Keychain
 * under the generic-password service name "Claude Code-credentials",
 * not in a flat file. The password value is a JSON envelope:
 *
 *   { "claudeAiOauth": { "accessToken": "...", "refreshToken": "...",
 *                         "expiresAt": ..., "scopes": [...] } }
 *
 * Pattern ported from NousResearch's hermes-agent
 * (`agent/anthropic_adapter.py:_read_claude_code_credentials_from_keychain`).
 * Non-throwing — every failure (not-darwin, security not installed,
 * entry missing, payload malformed) returns `null` so discovery treats
 * the source as "not available" rather than crashing.
 */

import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'

export interface ClaudeCodeOAuthCredential {
	readonly accessToken: string
	readonly refreshToken?: string
	readonly expiresAt?: number
	readonly scopes?: readonly string[]
}

export function readClaudeCodeKeychainCredential(): ClaudeCodeOAuthCredential | null {
	if (platform() !== 'darwin') return null

	let raw: string
	try {
		raw = execFileSync(
			'security',
			['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
			{ encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
		).trim()
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
 * Detect whether a credential value is an Anthropic OAuth-style token
 * (must be sent via `Authorization: Bearer`) vs a console API key (sent
 * via `x-api-key`). Ported from hermes's `_is_oauth_token` —
 * positively identifies by prefix; defaults to API-key when unsure.
 */
export function isAnthropicOAuthToken(value: string): boolean {
	if (value.startsWith('sk-ant-api')) return false // console API key
	if (value.startsWith('sk-ant-oat')) return true // Anthropic OAuth setup token
	if (value.startsWith('eyJ')) return true // JWT
	if (value.startsWith('cc-')) return true // Claude Code OAuth access token
	return false
}
