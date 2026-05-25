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

const KEYCHAIN_SERVICE = 'Claude Code-credentials'

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
 * Persist a refreshed OAuth credential back into the same Keychain entry so
 * the new access token survives across launches and Claude Code itself stays
 * in sync. The full envelope is re-read and merged (only the OAuth sub-fields
 * change) so any extra keys Claude Code stores are preserved. Non-throwing:
 * returns `false` (not-darwin, no entry, missing account, write denied) and
 * the caller falls back to using the refreshed token only in memory.
 *
 * Note: `security` takes the secret as an argv (`-w`), so it is briefly
 * visible to `ps` — acceptable for a local dev CLI updating a credential that
 * already lives on this machine.
 */
export function writeClaudeCodeKeychainCredential(cred: ClaudeCodeOAuthCredential): boolean {
	if (platform() !== 'darwin') return false
	// `add-generic-password -U` matches an existing item by service + account,
	// so we must reuse the original account or we'd create a duplicate entry.
	const account = readKeychainAccount()
	if (!account) return false

	let envelope: Record<string, unknown> = {}
	try {
		const raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
			encoding: 'utf8',
			timeout: 5_000,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim()
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed === 'object' && parsed !== null) envelope = parsed as Record<string, unknown>
	} catch {
		// Fall back to a fresh envelope below.
	}
	const prev =
		typeof envelope.claudeAiOauth === 'object' && envelope.claudeAiOauth !== null
			? (envelope.claudeAiOauth as Record<string, unknown>)
			: {}
	envelope.claudeAiOauth = {
		...prev,
		accessToken: cred.accessToken,
		...(cred.refreshToken ? { refreshToken: cred.refreshToken } : {}),
		...(cred.expiresAt ? { expiresAt: cred.expiresAt } : {}),
		...(cred.scopes ? { scopes: cred.scopes } : {}),
	}
	try {
		execFileSync(
			'security',
			[
				'add-generic-password',
				'-U',
				'-s',
				KEYCHAIN_SERVICE,
				'-a',
				account,
				'-w',
				JSON.stringify(envelope),
			],
			{ timeout: 5_000, stdio: ['ignore', 'ignore', 'ignore'] },
		)
		return true
	} catch {
		return false
	}
}

/** Read the account (`acct`) of the Claude Code Keychain entry, for updates. */
function readKeychainAccount(): string | null {
	try {
		const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], {
			encoding: 'utf8',
			timeout: 5_000,
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		const m = out.match(/"acct"<blob>="((?:[^"\\]|\\.)*)"/)
		return m?.[1] ?? null
	} catch {
		return null
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
