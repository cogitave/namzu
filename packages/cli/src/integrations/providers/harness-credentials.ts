/**
 * Read-only adapters for credentials owned by co-installed agent harnesses.
 *
 * These files are authorities, not migration inputs. Namzu reads the whole
 * record, validates only the fields its provider wire needs, and never writes
 * either file. In particular, refresh tokens remain owned by the harness that
 * obtained them; consuming a single-use refresh grant here would race that
 * owner and could log it out.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import type { AgentOAuthCredential } from './keychain.js'

const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024

export interface CodexOAuthCredential extends AgentOAuthCredential {
	readonly accountId: string
}

export function claudeCredentialsPath(home: string = homedir()): string {
	return join(home, '.claude', '.credentials.json')
}

export function codexCredentialsPath(
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	const configured = env.CODEX_HOME?.trim()
	const root = configured
		? isAbsolute(configured)
			? configured
			: resolve(configured)
		: join(home, '.codex')
	return join(root, 'auth.json')
}

function readCredentialJson(path: string): unknown | null {
	try {
		const stat = statSync(path)
		if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CREDENTIAL_FILE_BYTES) return null
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return null
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined
	return value as string[]
}

export function readClaudeFileCredential(home: string = homedir()): AgentOAuthCredential | null {
	return readClaudeCredentialFile(claudeCredentialsPath(home))
}

/** Read a Claude-owned credential from the exact path discovery admitted. */
export function readClaudeCredentialFile(path: string): AgentOAuthCredential | null {
	const root = record(readCredentialJson(path))
	const oauth = record(root?.claudeAiOauth)
	const accessToken = optionalString(oauth?.accessToken)
	if (!accessToken) return null
	return {
		accessToken,
		refreshToken: optionalString(oauth?.refreshToken),
		expiresAt: optionalFiniteNumber(oauth?.expiresAt),
		scopes: optionalStringArray(oauth?.scopes),
	}
}

interface JwtClaims {
	readonly expiresAt?: number
	readonly accountId?: string
}

export function codexCredentialFromTokens(tokens: {
	readonly accessToken: string
	readonly refreshToken?: string
	readonly accountId?: string
}): CodexOAuthCredential | null {
	if (tokens.accessToken.length === 0) return null
	const claims = jwtClaims(tokens.accessToken)
	const accountId = tokens.accountId ?? claims.accountId
	if (!accountId) return null
	return {
		accessToken: tokens.accessToken,
		...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
		accountId,
		...(claims.expiresAt === undefined ? {} : { expiresAt: claims.expiresAt }),
	}
}

function jwtClaims(token: string): JwtClaims {
	const parts = token.split('.')
	if (parts.length !== 3 || !parts[1]) return {}
	try {
		const payload = record(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')))
		const auth = record(payload?.['https://api.openai.com/auth'])
		const exp = optionalFiniteNumber(payload?.exp)
		return {
			...(exp === undefined ? {} : { expiresAt: exp * 1000 }),
			...(optionalString(auth?.chatgpt_account_id)
				? { accountId: optionalString(auth?.chatgpt_account_id) }
				: {}),
		}
	} catch {
		return {}
	}
}

/**
 * Read the ChatGPT subscription record produced by Codex CLI.
 *
 * `OPENAI_API_KEY` is intentionally ignored: it belongs to the ordinary
 * OpenAI provider. This reader admits only the `tokens` envelope used by the
 * Codex Responses backend and requires the account id that backend routes on.
 */
export function readCodexFileCredential(
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): CodexOAuthCredential | null {
	return readCodexCredentialFile(codexCredentialsPath(home, env))
}

/** Read a Codex-owned credential from the exact path discovery admitted. */
export function readCodexCredentialFile(path: string): CodexOAuthCredential | null {
	const root = record(readCredentialJson(path))
	const tokens = record(root?.tokens)
	const accessToken = optionalString(tokens?.access_token)
	if (!accessToken) return null
	const accessClaims = jwtClaims(accessToken)
	const idToken = optionalString(tokens?.id_token)
	const idClaims = idToken ? jwtClaims(idToken) : {}
	const accountId =
		optionalString(tokens?.account_id) ?? accessClaims.accountId ?? idClaims.accountId
	if (!accountId) return null
	return codexCredentialFromTokens({
		accessToken,
		...(optionalString(tokens?.refresh_token)
			? { refreshToken: optionalString(tokens?.refresh_token) }
			: {}),
		accountId,
	})
}

/** Prefer the credential whose access token remains valid for longer. */
export function preferFresherCredential<T extends AgentOAuthCredential>(
	left: T | null,
	right: T | null,
	now = Date.now(),
): T | null {
	if (!left) return right
	if (!right) return left
	const leftExpiry = left.expiresAt ?? Number.POSITIVE_INFINITY
	const rightExpiry = right.expiresAt ?? Number.POSITIVE_INFINITY
	const leftFresh = leftExpiry > now + 60_000
	const rightFresh = rightExpiry > now + 60_000
	if (leftFresh !== rightFresh) return leftFresh ? left : right
	return leftExpiry >= rightExpiry ? left : right
}
