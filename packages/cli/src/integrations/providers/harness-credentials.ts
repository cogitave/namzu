/** Adapters for credentials owned by co-installed agent harnesses. */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import type { AgentOAuthCredential } from './keychain.js'

const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024

export interface CodexOAuthCredential extends AgentOAuthCredential {
	readonly accountId: string
}

export interface HarnessCredentialCandidate<T extends AgentOAuthCredential> {
	readonly path: string
	readonly credential: T
}

export interface ClaudeCredentialReplaceResult {
	readonly replaced: boolean
	readonly current: AgentOAuthCredential | null
}

export function claudeCredentialsPath(home: string = homedir()): string {
	return join(home, '.claude', '.credentials.json')
}

/** Convert an absolute Windows path into the drive mount WSL exposes. */
export function windowsPathToWsl(path: string): string | null {
	const normalized = path.trim().replaceAll('\\', '/')
	const match = /^([A-Za-z]):\/(.+)$/u.exec(normalized)
	if (!match?.[1] || !match[2] || match[2].split('/').includes('..')) return null
	return `/mnt/${match[1].toLowerCase()}/${match[2]}`
}

/**
 * Resolve the Windows account paired with this WSL process.
 *
 * The Windows executable is pinned instead of searched through PATH: this
 * lookup decides where a credential may be read, so a project-local `cmd.exe`
 * must not be able to redirect it. Failure is an ordinary "no second home"
 * result; native Linux never starts a process.
 */
export function wslWindowsHome(
	env: NodeJS.ProcessEnv = process.env,
	run: typeof execFileSync = execFileSync,
	command = '/mnt/c/Windows/System32/cmd.exe',
): string | null {
	if (!env.WSL_DISTRO_NAME && !env.WSL_INTEROP) return null
	try {
		if (!statSync(command).isFile()) return null
		const output = run(command, ['/d', '/s', '/c', 'echo', '%USERPROFILE%'], {
			encoding: 'utf8',
			timeout: 1_000,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		return windowsPathToWsl(String(output))
	} catch {
		return null
	}
}

/**
 * Usable Claude sessions visible from this process, freshest first.
 *
 * WSL is one device with two home directories in practice. Claude may be
 * installed and signed in on Windows while Namzu runs inside WSL; treating the
 * Linux home as the whole device turns that valid subscription into a missing
 * credential. An explicit `home` remains hermetic for embeds and tests.
 */
export function readClaudeFileCredentialCandidates(
	home: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	windowsHome: string | null | undefined = home === undefined ? wslWindowsHome(env) : null,
): readonly HarnessCredentialCandidate<AgentOAuthCredential>[] {
	const paths = [
		claudeCredentialsPath(home),
		...(windowsHome ? [claudeCredentialsPath(windowsHome)] : []),
	]
	const unique = [...new Set(paths)]
	return unique.flatMap((path) => {
		const credential = readClaudeCredentialFile(path)
		return credential ? [{ path, credential }] : []
	})
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

function sameClaudeCredential(left: AgentOAuthCredential, right: AgentOAuthCredential): boolean {
	return (
		left.accessToken === right.accessToken &&
		left.refreshToken === right.refreshToken &&
		left.expiresAt === right.expiresAt &&
		JSON.stringify(left.scopes ?? []) === JSON.stringify(right.scopes ?? [])
	)
}

/**
 * Publish a refreshed Claude session back to the exact owner file discovered.
 *
 * Claude refresh grants may rotate. Keeping the successor only in Namzu would
 * consume the owner's grant and leave its file unusable, so this preserves the
 * full envelope and atomically replaces only its OAuth fields. The final
 * re-read lets an owner rotation that completed during the network request win.
 * Claude does not participate in Namzu's lock, so this is intentionally not
 * described as a cross-process CAS; it is the strongest owner-compatible
 * publication available for this shared file format.
 */
export function replaceClaudeCredentialFile(
	path: string,
	expected: AgentOAuthCredential,
	replacement: AgentOAuthCredential,
): ClaudeCredentialReplaceResult {
	const root = record(readCredentialJson(path))
	const oauth = record(root?.claudeAiOauth)
	const current = readClaudeCredentialFile(path)
	if (!root || !oauth || !current) return { replaced: false, current }
	if (!sameClaudeCredential(current, expected)) return { replaced: false, current }

	const updated = {
		...root,
		claudeAiOauth: {
			...oauth,
			accessToken: replacement.accessToken,
			...(replacement.refreshToken === undefined ? {} : { refreshToken: replacement.refreshToken }),
			...(replacement.expiresAt === undefined ? {} : { expiresAt: replacement.expiresAt }),
			...(replacement.scopes === undefined ? {} : { scopes: replacement.scopes }),
		},
	}
	const tempPath = join(
		dirname(path),
		`.${basename(path)}.namzu-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
	)
	let descriptor: number | undefined
	try {
		descriptor = openSync(tempPath, 'wx', 0o600)
		writeFileSync(descriptor, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
		fsyncSync(descriptor)
		closeSync(descriptor)
		descriptor = undefined

		const beforeCommit = readClaudeCredentialFile(path)
		if (!beforeCommit || !sameClaudeCredential(beforeCommit, expected)) {
			return { replaced: false, current: beforeCommit }
		}
		renameSync(tempPath, path)
		return { replaced: true, current: replacement }
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor)
			} catch {
				// The primary publication error remains authoritative.
			}
		}
		try {
			unlinkSync(tempPath)
		} catch {
			// A successful rename has already consumed the temporary name.
		}
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

/** Usable Codex sessions visible from this process, including a paired WSL host. */
export function readCodexFileCredentialCandidates(
	home: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
	windowsHome: string | null | undefined = home === undefined ? wslWindowsHome(env) : null,
): readonly HarnessCredentialCandidate<CodexOAuthCredential>[] {
	// CODEX_HOME is an explicit authority choice. Do not silently add another
	// store beside it, because two owners could then refresh independently.
	const paths = env.CODEX_HOME?.trim()
		? [codexCredentialsPath(home, env)]
		: [
				codexCredentialsPath(home, env),
				...(windowsHome ? [codexCredentialsPath(windowsHome, {})] : []),
			]
	return [...new Set(paths)].flatMap((path) => {
		const credential = readCodexCredentialFile(path)
		return credential ? [{ path, credential }] : []
	})
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
