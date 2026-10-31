/**
 * Reader for a Codex account that owns a private `CODEX_HOME`.
 *
 * A directory under `<NAMZU_HOME>/accounts/codex/<label>` holds the
 * `auth.json` that the official `codex login` wrote when it ran with
 * `CODEX_HOME` pointing there. Namzu is that directory's only reader, so it may
 * refresh the tokens in place. The pieces are the ones the single stored Codex
 * sign-in already uses: `readCodexCredentialFile` for the file shape,
 * `requestCodexRefresh` (the refresh call `ensureFreshStoredCodexCredential`
 * makes) for the grant, and the SDK's per-account refresh lock around the whole
 * read-refresh-write so two processes never spend one refresh token twice.
 */

import { randomBytes } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
	type AccountCredentialReaders,
	CredentialWithdrawnError as AccountCredentialWithdrawnError,
	type ResolvedAccountCredential,
	withAccountRefreshLock,
} from '@namzu/sdk'

import { codexCredentialIsDue, requestCodexRefresh } from './codex-oauth.js'
import {
	type CodexOAuthCredential,
	codexCredentialFromTokens,
	readCodexCredentialFile,
} from './harness-credentials.js'
import { CredentialWithdrawnError } from './oauth.js'

const MAX_AUTH_FILE_BYTES = 1024 * 1024

export interface CodexAccountReaderOptions {
	readonly fetch?: typeof fetch
	readonly authOrigin?: string
	readonly now?: () => number
	/** Waits between attempts to take the refresh lock; injected so a test never depends on the clock. */
	readonly wait?: (attempt: number) => Promise<void>
	/** How many times to try the refresh lock. A holder may be mid-refresh over the network. */
	readonly lockAttempts?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function sleep(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 100))
}

function same(left: CodexOAuthCredential, right: CodexOAuthCredential): boolean {
	return left.accessToken === right.accessToken && left.refreshToken === right.refreshToken
}

function resolved(credential: CodexOAuthCredential): ResolvedAccountCredential {
	return {
		kind: 'oauth',
		accessToken: credential.accessToken,
		accountId: credential.accountId,
		...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
	}
}

/**
 * Replace the token fields of `path` with `replacement`, keeping every other
 * field of the file. The file is re-read first: if its tokens are no longer
 * `expected`, someone else rotated them and their file wins.
 */
function publish(
	path: string,
	expected: CodexOAuthCredential,
	replacement: CodexOAuthCredential,
	now: number,
): CodexOAuthCredential {
	const beforeWrite = readCodexCredentialFile(path)
	if (!beforeWrite || !same(beforeWrite, expected)) {
		if (!beforeWrite) throw new CredentialWithdrawnError()
		return beforeWrite
	}
	const info = statSync(path)
	if (!info.isFile() || info.size > MAX_AUTH_FILE_BYTES) throw new CredentialWithdrawnError()
	const root = asRecord(JSON.parse(readFileSync(path, 'utf8')))
	const tokens = asRecord(root?.tokens)
	if (!root || !tokens) throw new CredentialWithdrawnError()
	const updated = {
		...root,
		tokens: {
			...tokens,
			access_token: replacement.accessToken,
			...(replacement.refreshToken === undefined
				? {}
				: { refresh_token: replacement.refreshToken }),
		},
		last_refresh: new Date(now).toISOString(),
	}
	const temporary = join(
		path.slice(0, path.length - 'auth.json'.length),
		`.auth.json.namzu-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
	)
	const fd = openSync(temporary, 'wx', 0o600)
	try {
		writeSync(fd, `${JSON.stringify(updated, null, 2)}\n`)
		fsyncSync(fd)
		closeSync(fd)
		renameSync(temporary, path)
	} catch (error) {
		try {
			closeSync(fd)
		} catch {
			// Already closed above; the original failure is the one to report.
		}
		try {
			unlinkSync(temporary)
		} catch {
			// A successful rename has consumed the temporary name.
		}
		throw error
	}
	return replacement
}

/**
 * The `codexHome` reader for `createAccountRegistry({ readers })`. A missing or
 * unusable `auth.json`, a refresh the server refuses, and a successor that
 * belongs to a different ChatGPT account all surface as the SDK's
 * `CredentialWithdrawnError` so the host can offer another account.
 */
export function createCodexHomeReader(
	options: CodexAccountReaderOptions = {},
): NonNullable<AccountCredentialReaders['codexHome']> {
	return async (account, signal) => {
		signal.throwIfAborted()
		const path = join(account.source.dir, 'auth.json')
		const withdrawn = (message: string) => new AccountCredentialWithdrawnError(account.id, message)
		try {
			return await withAccountRefreshLock(
				account.source.dir,
				async () => {
					const current = readCodexCredentialFile(path)
					if (!current) {
						throw withdrawn(
							'This Codex account has no usable sign-in. Add it again with the Codex sign-in.',
						)
					}
					const now = options.now?.() ?? Date.now()
					if (!codexCredentialIsDue(current, now)) return resolved(current)
					const refreshed = await requestCodexRefresh(current, signal, {
						...(options.fetch ? { fetch: options.fetch } : {}),
						...(options.authOrigin ? { authOrigin: options.authOrigin } : {}),
					})
					// The refresh call stamps the successor with the account it was asked
					// for, so a token that names another account is only visible in its claims.
					const claimed = codexCredentialFromTokens({ accessToken: refreshed.accessToken })
					if (claimed && claimed.accountId !== current.accountId) {
						throw withdrawn(
							'The refreshed sign-in belongs to a different account. Add this account again.',
						)
					}
					signal.throwIfAborted()
					return resolved(publish(path, current, refreshed, now))
				},
				{ attempts: options.lockAttempts ?? 300, wait: options.wait ?? sleep },
			)
		} catch (error) {
			if (error instanceof CredentialWithdrawnError) throw withdrawn(error.message)
			throw error
		}
	}
}
