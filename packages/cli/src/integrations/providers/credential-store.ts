/**
 * `~/.namzu/credentials.json` — the subscription credential namzu obtained itself.
 *
 * ## Why a file, said as a choice rather than a default
 *
 * The durable home a credential deserves is the operating system's own secret
 * store. namzu does not have one. The helper next door reads the macOS login
 * Keychain and belongs to a DIFFERENT product's entry — namzu borrows a token
 * from it — so writing namzu's own secret there would file our secret under
 * somebody else's name. On the platform this was asked for the store is not
 * that one at all, and no cross-platform binding exists in this package.
 *
 * So the options were: ship no durable credential, bind a native store per
 * platform, or own a file. This owns a file, and pays for it by making the
 * file's protection a CHECKED property rather than an assumption:
 *
 *  - it is created `0600` from birth (`wx` + mode, never a world-readable
 *    window), inside a `0700` directory;
 *  - after writing, the protection is READ BACK and asserted;
 *  - if the assertion cannot be made, the file is deleted and the write
 *    throws. A credential store that cannot prove it is private is a worse
 *    outcome than no credential store, and refusing is the rule this
 *    repository already holds ("refuse do not degrade").
 *
 * The assertion is per-platform because the underlying protection is:
 *
 *  - POSIX: `chmod 0600`, then `stat` and require no group/other bits.
 *  - Windows: POSIX modes do not exist — `fs.chmod` there only toggles the
 *    read-only attribute, so a `0600` that "succeeded" would prove nothing.
 *    The equivalent is a discretionary ACL, so inheritance is removed and a
 *    full-control entry is granted to the current user's SID; the ACL is then
 *    saved back as SDDL and checked for access by that user. An existing
 *    LocalSystem grant is permitted; grants to other accounts are refused.
 *
 * ## What is in the file
 *
 *   { "version": 1,
 *     "subscription": { "accessToken", "refreshToken", "expiresAt", "scopes" },
 *     "codexSubscription": { "accessToken", "refreshToken", "expiresAt", "accountId" } }
 *
 * Each sibling is owned by Namzu's corresponding login flow and conditionally
 * refreshed in place. Credentials borrowed from Claude or Codex remain in
 * their owners' files/keychain and are never copied here.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { basename, dirname, join, toNamespacedPath } from 'node:path'

import { createAccountRegistry } from '@namzu/sdk'

import { createAccountActivityStore } from '../accounts/activity.js'
import { namzuHomePath } from '../state/home.js'
import { readAccountKeys, readAccountStartupKey } from './account-keys.js'
import { desktopCredentialsPath } from './desktop-sign-in.js'
import type { AgentOAuthCredential } from './keychain.js'

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export const CREDENTIALS_FILE_VERSION = 1 as const

/** Thrown when a credential could not be stored *privately*. Never carries a secret. */
export class CredentialStoreError extends Error {
	override readonly name = 'CredentialStoreError'
}

export type ConditionalCredentialWrite =
	| { readonly replaced: true; readonly current: AgentOAuthCredential }
	| { readonly replaced: false; readonly current: AgentOAuthCredential | null }

export interface StoredCodexCredential extends AgentOAuthCredential {
	readonly accountId: string
}

export type ConditionalCodexCredentialWrite =
	| { readonly replaced: true; readonly current: StoredCodexCredential }
	| {
			readonly replaced: false
			readonly current: StoredCodexCredential | null
	  }

interface CredentialDocument {
	readonly version: typeof CREDENTIALS_FILE_VERSION
	readonly subscription?: AgentOAuthCredential
	readonly codexSubscription?: StoredCodexCredential
}

export function credentialsPath(home?: string): string {
	return join(namzuHomePath(home), 'credentials.json')
}

/** Kept separate from subscriptions so older credentials.json writers cannot erase it. */
export function googleApiKeyPath(home?: string): string {
	return join(namzuHomePath(home), 'gemini-api-key.json')
}

/**
 * Whether no entry exists at `path`. Looking a name up opens no handle to a
 * file's data, so a missing credential is answered without first proving its
 * directory private: on Windows that proof is two processes, and discovery
 * asks about several files that usually do not exist. A file that exists is
 * still proved, directory first, before it is opened.
 */
function credentialEntryAbsent(path: string): boolean {
	try {
		lstatSync(path)
		return false
	} catch (error) {
		return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
	}
}

/** Return only a Namzu-owned, private Gemini API key. Never read a symlink. */
export function readStoredGeminiApiKey(home?: string): string | null {
	return readOwnGeminiApiKey(home) ?? readAccountStartupKey('google', home)
}

/** The Gemini key file alone, without the account fallback. */
function readOwnGeminiApiKey(home?: string): string | null {
	const path = googleApiKeyPath(home)
	if (credentialEntryAbsent(path)) return null
	try {
		protectCredentialParentOnWindows(path)
		const entry = lstatSync(path)
		if (!entry.isFile() || entry.isSymbolicLink()) return null
		restrictToOwner(path)
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
		if (typeof parsed !== 'object' || parsed === null) return null
		const record = parsed as Record<string, unknown>
		return record.version === 1 && typeof record.apiKey === 'string' && record.apiKey.trim()
			? record.apiKey
			: null
	} catch {
		return null
	}
}

/** Atomically publish a verified-private key after a usable Google session opens. */
export function writeStoredGeminiApiKey(apiKey: string, home?: string): string {
	if (!apiKey.trim()) throw new CredentialStoreError('Cannot store an empty Gemini API key.')
	const path = googleApiKeyPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	return withCredentialStoreLock(path, () =>
		writeCredentialBodyUnlocked(`${JSON.stringify({ version: 1, apiKey })}\n`, path),
	)
}

/**
 * Remove Namzu's Gemini key without changing environment or Gemini CLI credentials.
 * The account that holds the same key goes with it, because the account is the
 * only other place startup reads it from; accounts holding another key stay.
 * Accounts go first, so a failure leaves the key file and the sign-in in step.
 */
export function clearStoredGeminiApiKey(home?: string): void {
	const path = googleApiKeyPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	const startup = readOwnGeminiApiKey(home) ?? readAccountStartupKey('google', home)
	if (startup !== null) forgetAccountsHolding('google', startup, home)
	withCredentialStoreLock(path, () => rmSync(path, { force: true }))
}

/**
 * Remove the Gemini key file only when it still holds `expected`, under the
 * store lock. Returns whether it was removed. Used to retire a duplicate.
 */
export function clearStoredGeminiApiKeyIf(expected: string, home?: string): boolean {
	const path = googleApiKeyPath(home)
	return withCredentialStoreLock(path, () => {
		if (readOwnGeminiApiKey(home) !== expected) return false
		rmSync(path, { force: true })
		return true
	})
}

/**
 * Namzu-owned API keys a person pasted for a provider, one file for all of them.
 * Gemini keeps its own file above so older writers stay readable; every other
 * provider that accepts a typed key lives here, written with the same
 * verified-private protection. Environment variables still win in discovery.
 */
export function apiKeysPath(home?: string): string {
	return join(namzuHomePath(home), 'api-keys.json')
}

function readApiKeyDocument(home?: string): Record<string, string> {
	const path = apiKeysPath(home)
	if (credentialEntryAbsent(path)) return {}
	try {
		protectCredentialParentOnWindows(path)
		const entry = lstatSync(path)
		if (!entry.isFile() || entry.isSymbolicLink()) return {}
		restrictToOwner(path)
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
		if (typeof parsed !== 'object' || parsed === null) return {}
		const record = parsed as { version?: unknown; keys?: unknown }
		if (record.version !== 1 || typeof record.keys !== 'object' || record.keys === null) return {}
		const keys: Record<string, string> = Object.create(null)
		for (const [id, value] of Object.entries(record.keys as Record<string, unknown>))
			if (typeof value === 'string' && value.trim()) keys[id] = value
		return keys
	} catch {
		return {}
	}
}

/** The saved key for one provider id, or `null`. Never throws. */
export function readStoredApiKey(providerId: string, home?: string): string | null {
	return readApiKeyDocument(home)[providerId] ?? readAccountStartupKey(providerId, home)
}

/** The key in `api-keys.json` alone, without the account fallback. */
export function readOwnStoredApiKey(providerId: string, home?: string): string | null {
	return readApiKeyDocument(home)[providerId] ?? null
}

/**
 * Every saved key at once, from one read of the file, for a caller that asks
 * about several providers (discovery): each read proves the file private, which
 * on Windows is four processes. Never throws.
 */
export function readStoredApiKeys(home?: string): Readonly<Record<string, string>> {
	const keys = readApiKeyDocument(home)
	for (const entry of readAccountKeys(home))
		if (!(entry.provider in keys) && entry.provider !== 'google') keys[entry.provider] = entry.key
	return keys
}

/** Provider ids that have a saved key. Never carries a key. */
export function listStoredApiKeyProviders(home?: string): string[] {
	return Object.keys(readStoredApiKeys(home))
}

/** Save one provider's key, keeping the others. Throws `CredentialStoreError` if it cannot be made private. */
export function writeStoredApiKey(providerId: string, apiKey: string, home?: string): string {
	if (!apiKey.trim()) throw new CredentialStoreError('Cannot store an empty API key.')
	const path = apiKeysPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	return withCredentialStoreLock(path, () =>
		writeCredentialBodyUnlocked(
			`${JSON.stringify({ version: 1, keys: { ...readApiKeyDocument(home), [providerId]: apiKey } })}\n`,
			path,
		),
	)
}

function removeOwnKey(providerId: string, home: string | undefined, expected?: string): boolean {
	const path = apiKeysPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	return withCredentialStoreLock(path, () => {
		const { [providerId]: current, ...rest } = readApiKeyDocument(home)
		if (expected !== undefined && current !== expected) return false
		if (Object.keys(rest).length === 0) rmSync(path, { force: true })
		else writeCredentialBodyUnlocked(`${JSON.stringify({ version: 1, keys: rest })}\n`, path)
		return true
	})
}

/**
 * Remove one provider's saved key; the file goes when it was the last. The
 * plain `/auth` accounts that hold that same key go too, since leaving them
 * would keep the key; an account with a different key is not named by a
 * logout and stays. Accounts go first and a failure stops before the key file
 * is touched, so the two never end half done.
 */
export function clearStoredApiKey(providerId: string, home?: string): void {
	const startup = readOwnStoredApiKey(providerId, home) ?? readAccountStartupKey(providerId, home)
	if (startup !== null) forgetAccountsHolding(providerId, startup, home)
	removeOwnKey(providerId, home)
}

/**
 * Remove one provider's key from `api-keys.json` only when it still holds
 * `expected`, under the store lock; accounts are untouched. Returns whether it
 * was removed. Used to retire a duplicate of an account's key.
 */
export function clearStoredApiKeyIf(providerId: string, expected: string, home?: string): boolean {
	return removeOwnKey(providerId, home, expected)
}

/**
 * Remove every saved provider key at once (`/logout all`), and the plain
 * accounts that hold each provider's startup key. Gemini's key has its own
 * clear and is left to it.
 */
export function clearAllStoredApiKeys(home?: string): void {
	const path = apiKeysPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	const own = readApiKeyDocument(home)
	const providers = new Set([...Object.keys(own), ...readAccountKeys(home).map((e) => e.provider)])
	providers.delete('google')
	for (const provider of providers) {
		const startup = own[provider] ?? readAccountStartupKey(provider, home)
		if (startup !== null) forgetAccountsHolding(provider, startup, home)
	}
	withCredentialStoreLock(path, () => rmSync(path, { force: true }))
}

/**
 * Remove the plain API-key accounts of a provider whose key is `key`, with
 * their last-use records. Each is tried; if any fails, this throws after the
 * rest were tried and names how many remain, so the caller stops before it
 * removes the key file and the person is told.
 */
function forgetAccountsHolding(provider: string, key: string, home?: string): void {
	const entries = readAccountKeys(home).filter(
		(entry) => entry.provider === provider && entry.key === key,
	)
	if (entries.length === 0) return
	const base = home === undefined ? undefined : namzuHomePath(home)
	const registry = createAccountRegistry(base === undefined ? {} : { home: base })
	const activity = createAccountActivityStore(base === undefined ? {} : { home: base })
	const failed: string[] = []
	for (const entry of entries) {
		try {
			registry.remove(entry.accountId)
			activity.forget(entry.accountId)
		} catch {
			failed.push(entry.accountId)
		}
	}
	if (failed.length > 0)
		throw new CredentialStoreError(
			`Could not remove ${failed.length} saved account${failed.length === 1 ? '' : 's'} holding the ${provider} key; the saved key was kept.`,
		)
}

/**
 * The stored subscription credential, or `null` when there is none.
 *
 * Non-throwing on every shape of absence and corruption — a store that
 * refuses to parse is "no credential", which is what discovery can act on.
 * It does NOT swallow a permission error into `null` silently; that is still
 * absence from the reader's point of view, and the login path is what tells
 * the operator to try again.
 */
export function readStoredSubscriptionCredential(home?: string): AgentOAuthCredential | null {
	return heldCredential('subscription', home)?.credential ?? null
}

/** The Namzu-owned ChatGPT/Codex subscription, if one was obtained here. */
export function readStoredCodexCredential(home?: string): StoredCodexCredential | null {
	return heldCredential('codexSubscription', home)?.credential ?? null
}

type CredentialKey = 'subscription' | 'codexSubscription'

/** Where a stored sign-in lives: this home's file, or Namzu Desktop's on the paired Windows side. */
export interface StoredCredentialLocation {
	readonly path: string
	readonly shared: 'desktop' | null
}

/**
 * The credential `key` and the file that holds it. This home's own file always wins; the
 * paired Windows store (see `desktop-sign-in.ts`) is asked only for a provider the own file
 * does not hold, and only when the default home is in use.
 */
function heldCredential<K extends CredentialKey>(
	key: K,
	home?: string,
): {
	readonly credential: NonNullable<CredentialDocument[K]>
	readonly location: StoredCredentialLocation
} | null {
	const ownPath = credentialsPath(home)
	const own = readCredentialDocumentAt(ownPath)?.[key]
	if (own)
		return {
			credential: own as NonNullable<CredentialDocument[K]>,
			location: { path: ownPath, shared: null },
		}
	if (home !== undefined) return null
	const pairedPath = desktopCredentialsPath()
	if (pairedPath === null) return null
	const paired = readCredentialDocumentAt(pairedPath)?.[key]
	return paired
		? {
				credential: paired as NonNullable<CredentialDocument[K]>,
				location: { path: pairedPath, shared: 'desktop' },
			}
		: null
}

/** Which file holds the Namzu-owned Claude sign-in, for a surface that says where it came from. */
export function locateStoredSubscriptionCredential(home?: string): StoredCredentialLocation | null {
	return heldCredential('subscription', home)?.location ?? null
}

/** Which file holds the Namzu-owned Codex sign-in. */
export function locateStoredCodexCredential(home?: string): StoredCredentialLocation | null {
	return heldCredential('codexSubscription', home)?.location ?? null
}

/**
 * The store a conditional write must go to: the one that holds `expected`, so one credential
 * is read and written in one file for its whole life. Own file when it matches or when no
 * paired store applies; the paired Windows store when it holds `expected`, or when the own
 * file holds no such sign-in at all (so a rotation made on the Windows side is returned to
 * the caller rather than reported as a withdrawn sign-in).
 */
function storeForWrite<K extends CredentialKey>(
	key: K,
	home: string | undefined,
	matches: (current: CredentialDocument[K] | undefined) => boolean,
): StoredCredentialLocation {
	const ownPath = credentialsPath(home)
	const own = readCredentialDocumentAt(ownPath)?.[key]
	if (home !== undefined || matches(own)) return { path: ownPath, shared: null }
	const pairedPath = desktopCredentialsPath()
	if (pairedPath === null) return { path: ownPath, shared: null }
	const paired = readCredentialDocumentAt(pairedPath)?.[key]
	if (matches(paired) || (own === undefined && paired !== undefined)) {
		return { path: pairedPath, shared: 'desktop' }
	}
	return { path: ownPath, shared: null }
}

function readCredentialDocument(home?: string): CredentialDocument | null {
	return readCredentialDocumentAt(credentialsPath(home))
}

function readCredentialDocumentAt(path: string): CredentialDocument | null {
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch {
		return null
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const root = parsed as {
		subscription?: unknown
		codexSubscription?: unknown
	}
	const subscription = parseCredential(root.subscription)
	const codexBase = parseCredential(root.codexSubscription)
	const codexRecord =
		typeof root.codexSubscription === 'object' && root.codexSubscription !== null
			? (root.codexSubscription as Record<string, unknown>)
			: null
	const accountId = codexRecord?.accountId
	const codexSubscription =
		codexBase && typeof accountId === 'string' && accountId.length > 0
			? { ...codexBase, accountId }
			: undefined
	if (!subscription && !codexSubscription) return null
	return {
		version: CREDENTIALS_FILE_VERSION,
		...(subscription ? { subscription } : {}),
		...(codexSubscription ? { codexSubscription } : {}),
	}
}

function parseCredential(value: unknown): AgentOAuthCredential | null {
	if (typeof value !== 'object' || value === null) return null
	const rec = value as Record<string, unknown>
	const accessToken = rec.accessToken
	if (typeof accessToken !== 'string' || accessToken.length === 0) return null
	return {
		accessToken,
		refreshToken: typeof rec.refreshToken === 'string' ? rec.refreshToken : undefined,
		expiresAt: typeof rec.expiresAt === 'number' ? rec.expiresAt : undefined,
		scopes: Array.isArray(rec.scopes)
			? (rec.scopes.filter((s) => typeof s === 'string') as string[])
			: undefined,
	}
}

/**
 * Write the credential, privately, or throw having written nothing that lasts.
 *
 * Ordering matters and is the whole point: the temporary file is created with
 * the restrictive mode, secured, asserted, and only then renamed into place.
 * A file that appears at the final path and is tightened afterwards has a
 * window in which it is readable, and that window is the defect this ordering
 * removes.
 */
export function writeStoredSubscriptionCredential(
	cred: AgentOAuthCredential,
	home?: string,
): string {
	const path = credentialsPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	return withCredentialStoreLock(path, () => {
		const current = readCredentialDocument(home)
		return writeCredentialDocumentUnlocked(
			{ version: CREDENTIALS_FILE_VERSION, ...current, subscription: cred },
			path,
		)
	})
}

export function writeStoredCodexCredential(cred: StoredCodexCredential, home?: string): string {
	const path = credentialsPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	return withCredentialStoreLock(path, () => {
		const current = readCredentialDocument(home)
		return writeCredentialDocumentUnlocked(
			{
				version: CREDENTIALS_FILE_VERSION,
				...current,
				codexSubscription: cred,
			},
			path,
		)
	})
}

export function replaceStoredCodexCredential(
	expected: StoredCodexCredential,
	replacement: StoredCodexCredential,
	home?: string,
): ConditionalCodexCredentialWrite {
	const store = storeForWrite('codexSubscription', home, (held) =>
		sameCodexCredential(held ?? null, expected),
	)
	return inStore(store, (path) => {
		const document = readCredentialDocumentAt(path)
		const current = document?.codexSubscription ?? null
		if (!sameCodexCredential(current, expected)) return { replaced: false, current }
		writeCredentialDocumentUnlocked(
			{
				version: CREDENTIALS_FILE_VERSION,
				...document,
				codexSubscription: replacement,
			},
			path,
			store.shared !== null,
		)
		return { replaced: true, current: replacement }
	})
}

/**
 * Run `operation` under the store lock of the chosen file. The own home's directory is
 * created on demand; the paired Windows directory is never created or changed by the terminal,
 * and a lock that cannot be taken there is said in terms of Desktop rather than a bare
 * "another owner".
 */
function inStore<T>(store: StoredCredentialLocation, operation: (path: string) => T): T {
	if (store.shared === null) {
		mkdirSync(dirname(store.path), { recursive: true, mode: DIR_MODE })
		return withCredentialStoreLock(store.path, () => operation(store.path))
	}
	try {
		return withCredentialStoreLock(store.path, () => operation(store.path))
	} catch (error) {
		if (error instanceof CredentialStoreError) {
			throw new CredentialStoreError(
				`the sign-in shared from Namzu Desktop on Windows could not be updated safely (${error.message}). Namzu Desktop keeps it current while it runs; or sign in on this terminal to keep a sign-in of its own.`,
			)
		}
		throw error
	}
}

/**
 * Replace exactly the credential a refresh was derived from.
 *
 * Comparison and rename happen under the same store-owned cross-process lock.
 * A changed record is returned to the caller and is never overwritten. This is
 * the durable authority boundary a post-network plain reread cannot provide:
 * without the lock, another writer can still rotate the credential between
 * the comparison and the rename.
 */
export function replaceStoredSubscriptionCredential(
	expected: AgentOAuthCredential,
	replacement: AgentOAuthCredential,
	home?: string,
): ConditionalCredentialWrite {
	const store = storeForWrite('subscription', home, (held) =>
		sameCredential(held ?? null, expected),
	)
	return inStore(store, (path) => {
		const document = readCredentialDocumentAt(path)
		const current = document?.subscription ?? null
		if (!sameCredential(current, expected)) return { replaced: false, current }
		writeCredentialDocumentUnlocked(
			{
				version: CREDENTIALS_FILE_VERSION,
				...document,
				subscription: replacement,
			},
			path,
			store.shared !== null,
		)
		return { replaced: true, current: replacement }
	})
}

function writeCredentialDocumentUnlocked(
	document: CredentialDocument,
	path: string,
	pairedWindowsStore = false,
): string {
	const body = `${JSON.stringify(serializeDocument(document), null, 2)}\n`
	return writeCredentialBodyUnlocked(body, path, pairedWindowsStore)
}

/**
 * `pairedWindowsStore` is the Windows side's file reached through the mounted drive. That
 * drive reports every file as mode 0777, so the POSIX owner-only proof cannot be made and
 * would refuse every write; the file's protection is the Windows profile's access list,
 * which the temp file inherits from the directory the Windows side made private.
 */
function writeCredentialBodyUnlocked(
	body: string,
	path: string,
	pairedWindowsStore = false,
): string {
	const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`

	let fd: number | undefined
	let placing = false
	try {
		// `wx` — refuse an existing path rather than truncate one, so a name
		// collision can never hand us a file somebody else already opened.
		fd = openSync(tmp, 'wx', FILE_MODE)
		// On Windows, `0600` does not govern the ACL. Prove the still-empty
		// file is private before putting a credential into it.
		if (!pairedWindowsStore) restrictToOwner(tmp)
		const bytes = Buffer.from(body, 'utf8')
		for (let offset = 0; offset < bytes.length; ) {
			const written = writeSync(fd, bytes, offset, bytes.length - offset)
			if (written <= 0 || written > bytes.length - offset) {
				throw new Error('credential write did not make progress')
			}
			offset += written
		}
		fsyncSync(fd)
		closeSync(fd)
		fd = undefined
		// Re-check after the write, before the name becomes discoverable.
		if (!pairedWindowsStore) restrictToOwner(tmp)
		placing = true
		renameSync(tmp, path)
		return path
	} catch (err) {
		if (fd !== undefined) {
			try {
				closeSync(fd)
			} catch {
				// A failed close may already have closed the descriptor. Remove the
				// temporary name in either case and report if that also fails.
			}
		}
		let cleanupError: unknown
		try {
			rmSync(tmp, { force: true })
		} catch (error) {
			cleanupError = error
		}
		throw new CredentialStoreError(
			`could not ${placing ? 'place' : 'write'} ${path}: ${err instanceof Error ? err.message : String(err)}${cleanupError ? `; temporary file ${tmp} could not be removed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}` : ''}`,
		)
	}
}

function serializeDocument(document: CredentialDocument): Record<string, unknown> {
	const credential = (value: AgentOAuthCredential) => ({
		accessToken: value.accessToken,
		...(value.refreshToken ? { refreshToken: value.refreshToken } : {}),
		...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
		...(value.scopes ? { scopes: value.scopes } : {}),
	})
	return {
		version: CREDENTIALS_FILE_VERSION,
		...(document.subscription ? { subscription: credential(document.subscription) } : {}),
		...(document.codexSubscription
			? {
					codexSubscription: {
						...credential(document.codexSubscription),
						accountId: document.codexSubscription.accountId,
					},
				}
			: {}),
	}
}

/** Remove the stored credential. Absence is success. */
export function clearStoredSubscriptionCredential(home?: string): void {
	const path = credentialsPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	withCredentialStoreLock(path, () => {
		const current = readCredentialDocument(home)
		if (!current?.codexSubscription) {
			rmSync(path, { force: true })
			return
		}
		writeCredentialDocumentUnlocked(
			{
				version: CREDENTIALS_FILE_VERSION,
				codexSubscription: current.codexSubscription,
			},
			path,
		)
	})
}

/** Remove only the Namzu-owned Codex subscription; borrowed harness auth is untouched. */
export function clearStoredCodexCredential(home?: string): void {
	const path = credentialsPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	withCredentialStoreLock(path, () => {
		const current = readCredentialDocument(home)
		if (!current?.subscription) {
			rmSync(path, { force: true })
			return
		}
		writeCredentialDocumentUnlocked(
			{ version: CREDENTIALS_FILE_VERSION, subscription: current.subscription },
			path,
		)
	})
}

/** Remove every credential Namzu owns in one store mutation. */
export function clearAllStoredCredentials(home?: string): void {
	const path = credentialsPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	withCredentialStoreLock(path, () => rmSync(path, { force: true }))
}

function sameCredential(left: AgentOAuthCredential | null, right: AgentOAuthCredential): boolean {
	if (!left) return false
	if (
		left.accessToken !== right.accessToken ||
		left.refreshToken !== right.refreshToken ||
		left.expiresAt !== right.expiresAt
	) {
		return false
	}
	const leftScopes = left.scopes ?? []
	const rightScopes = right.scopes ?? []
	return (
		leftScopes.length === rightScopes.length &&
		leftScopes.every((scope, index) => scope === rightScopes[index])
	)
}

function sameCodexCredential(
	left: StoredCodexCredential | null,
	right: StoredCodexCredential,
): boolean {
	return left?.accountId === right.accountId && sameCredential(left, right)
}

/**
 * Run one synchronous store mutation with cross-process exclusion.
 *
 * The lock is held only across local read/rename work, never across a network
 * request. A dead owner can leave a complete lock behind. It is deliberately
 * not stolen automatically: pathname-based stale reclamation cannot prove it
 * is unlinking the inode it inspected, so a delayed reclaimer can delete a new
 * owner's lock and admit two writers. A present lock is a refusal until an
 * operator proves no process owns the store and removes it.
 */
function withCredentialStoreLock<T>(path: string, operation: () => T): T {
	protectCredentialParentOnWindows(path)
	const lockPath = `${path}.lock`
	const token = `${process.pid}:${Date.now()}:${randomBytes(12).toString('hex')}`
	const published = publishLockAtomically(lockPath, token)
	if (!published.acquired) {
		throw new CredentialStoreError(
			`could not acquire the credential-store lock for ${path}: another owner or an unrecovered process lock is present (${published.error instanceof Error ? published.error.message : String(published.error)}). Refusing concurrent mutation; after proving no Namzu process is using this credential store, remove ${lockPath} and retry.`,
		)
	}

	try {
		removeCredentialTempsUnlocked(path)
		return operation()
	} finally {
		// Do not remove a successor's lock if an external actor replaced the file.
		try {
			if (readFileSync(lockPath, 'utf8') === token) rmSync(lockPath, { force: true })
		} catch {
			// The mutation already has its result. A missing/replaced lock is not
			// evidence that the credential itself failed to publish.
		}
	}
}

/** Protect the directory before opening any child of it on Windows. */
function protectCredentialParentOnWindows(path: string): void {
	if (platform() !== 'win32') return
	// Windows grants access when a handle is opened. Tightening an empty temp
	// later cannot revoke another account's already-open handle. The parent
	// must be private before even the lock candidate or credential file opens.
	const parent = dirname(path)
	const entry = lstatSync(parent)
	if (entry.isSymbolicLink() || !entry.isDirectory()) {
		throw new CredentialStoreError(`credential directory must be a real directory: ${parent}`)
	}
	restrictToOwner(parent)
}

/** Only a store-lock owner may remove crash leftovers, never an active writer. */
function removeCredentialTempsUnlocked(path: string): void {
	const prefix = `${basename(path)}.tmp.`
	try {
		for (const entry of readdirSync(dirname(path))) {
			if (!entry.startsWith(prefix) || !/^\d+\.[0-9a-f]{12}$/u.test(entry.slice(prefix.length))) {
				continue
			}
			rmSync(join(dirname(path), entry), { force: true })
		}
	} catch (error) {
		throw new CredentialStoreError(
			`could not remove temporary credential files for ${path}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

/**
 * Publish a complete owner record at the canonical name in one filesystem op.
 *
 * Creating the canonical file and then writing its token has a fatal crash
 * window: an empty lock names no owner and can never be reclaimed safely. The
 * candidate is completed and synced first; `linkSync` is the exclusive claim.
 * A pre-link crash can leave candidate debris, but it never blocks the store.
 */
function publishLockAtomically(
	lockPath: string,
	token: string,
): { readonly acquired: true } | { readonly acquired: false; readonly error: unknown } {
	const candidatePath = `${lockPath}.candidate.${process.pid}.${randomBytes(12).toString('hex')}`
	let fd: number | undefined
	try {
		fd = openSync(candidatePath, 'wx', FILE_MODE)
		writeFileSync(fd, token, 'utf8')
		fsyncSync(fd)
		closeSync(fd)
		fd = undefined
	} catch (error) {
		if (fd !== undefined) closeSync(fd)
		rmSync(candidatePath, { force: true })
		throw new CredentialStoreError(
			`could not prepare the credential-store lock: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	try {
		linkSync(candidatePath, lockPath)
		return { acquired: true }
	} catch (error) {
		return { acquired: false, error }
	} finally {
		try {
			rmSync(candidatePath, { force: true })
		} catch {
			// Candidate debris is non-canonical and cannot block another owner.
			// Once the hard link succeeds, cleanup must not erase that acquisition
			// result and skip the token-checked canonical release path.
		}
	}
}
/**
 * Make `path` private to the current account, and PROVE it. Windows may retain
 * access for the operating system's LocalSystem account. Throws
 * `CredentialStoreError` when the proof cannot be produced.
 *
 * Exported because it is the load-bearing half of this module and a security
 * property nobody can check by reading the caller.
 */
export function restrictToOwner(path: string): void {
	restrictToOwnerWith(path, false)
}

/**
 * `restrictToOwner` for a generated state directory that is opened again and again in one run. A
 * directory this process already proved private, and that is still the same directory (device,
 * file id, creation time), is not proved again on Windows, where each proof is three processes.
 * Credential files and the directories that hold them never use this: they are proved at every
 * read and write.
 */
export function restrictToOwnerOnce(path: string): void {
	restrictToOwnerWith(path, true)
}

function restrictToOwnerWith(path: string, once: boolean): void {
	if (platform() === 'win32') {
		restrictToOwnerWindows(path, once)
		return
	}
	// POSIX. `openSync` already asked for the mode; a umask cannot loosen it,
	// but an inherited ACL or an exotic filesystem can, so this reads it back
	// instead of trusting the request.
	let mode: number
	try {
		mode = statSync(path).mode
	} catch (err) {
		throw new CredentialStoreError(
			`could not read back the permissions of ${path}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	assertOwnerOnlyMode(mode, path)
}

/**
 * Require a POSIX mode to grant nothing to group or other.
 *
 * Split out for the same reason `assertSoleOwnerSddl` is: it is the actual
 * assertion, and one that only ever executes on some platforms is one most
 * contributors never see fail. As a pure function it is checked everywhere,
 * including by whoever is on the operating system where the branch that calls
 * it is unreachable.
 */
export function assertOwnerOnlyMode(mode: number, path: string): void {
	if ((mode & 0o077) !== 0) {
		throw new CredentialStoreError(
			`${path} is readable beyond its owner (mode ${(mode & 0o777).toString(8)}) and the filesystem would not tighten it — refusing to keep a credential there.`,
		)
	}
}

/**
 * The Windows half: remove inheritance, grant the current user's SID full
 * control, then read the resulting ACL back as SDDL. Existing explicit grants
 * survive `/inheritance:r` and `/grant:r`; only LocalSystem may remain beside
 * the current account. Directory grants propagate to children, so Windows does
 * not substitute the creator token's default ACL for new state partitions.
 * Directory protection also removes the built-in Administrators grant; it does
 * not accept that group as private. Other account grants are refused.
 *
 * Both helpers are invoked by absolute path under `%SystemRoot%\System32`.
 * Resolving them through `PATH` is how a same-named executable earlier on the
 * path gets to answer a security question on our behalf, and on a developer
 * machine `PATH` routinely carries a POSIX toolchain that shadows these names.
 */
function restrictToOwnerWindows(path: string, once: boolean): void {
	const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
	const run = (exe: string, args: readonly string[]): string => {
		try {
			return execFileSync(join(system32, exe), [...args], {
				encoding: 'utf8',
				timeout: 10_000,
				stdio: ['ignore', 'pipe', 'ignore'],
				windowsHide: true,
			})
		} catch (err) {
			throw new CredentialStoreError(
				`${exe} could not secure ${path} (${err instanceof Error ? err.message : String(err)}). namzu will not keep a credential in a file it cannot prove is private.`,
			)
		}
	}

	// `whoami /user /fo csv /nh` prints  "DOMAIN\user","S-1-5-21-…"
	const sid = currentUserSid()
	if (!sid) {
		throw new CredentialStoreError(
			`could not determine the current account’s security identifier, so the protection of ${path} cannot be established.`,
		)
	}

	const stat = statSync(path, { bigint: true })
	const directory = stat.isDirectory()
	// For generated state only (`once`): a directory this process already proved private, and that
	// is still the very same directory, is not proved again. Each proof is three Windows
	// processes, and state partitions are opened many times in one run. A replaced directory has
	// another identity and is proved afresh.
	const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
	if (once && directory && provenPrivateDirectories.has(path, identity)) return
	run('icacls.exe', [
		toNamespacedPath(path),
		'/inheritance:r',
		'/grant:r',
		`*${sid}:${directory ? '(OI)(CI)F' : 'F'}`,
		// Tighten the named private directory, including older generated state
		// whose non-inheritable parent caused Windows to add this default grant.
		// Never reset the ACL through a potentially wider parent descriptor.
		...(directory ? ['/remove:g', '*S-1-5-32-544'] : []),
	])

	const saved = readAclSddl(path)
	if (saved === null) {
		throw new CredentialStoreError(
			`could not read back the access-control list of ${path}, so its privacy is unestablished.`,
		)
	}
	assertSoleOwnerSddl(saved, sid, path)
	if (once && directory) provenPrivateDirectories.remember(path, identity)
}

/**
 * Directories this process has already proved private, by path and by the directory's identity
 * (device, inode, creation time), so a path that now names a different directory is not trusted.
 * It remembers a proof only after the read-back succeeded, never a failure, and holds a bounded
 * number of entries. Exported for its tests; the proof itself stays in `restrictToOwnerWindows`.
 */
export function createDirectoryProofCache(limit = 256) {
	const proven = new Map<string, string>()
	return {
		has: (path: string, identity: string): boolean => proven.get(path) === identity,
		remember(path: string, identity: string): void {
			if (!proven.has(path) && proven.size >= limit) proven.clear()
			proven.set(path, identity)
		},
		forget: (path: string): void => {
			proven.delete(path)
		},
		get size(): number {
			return proven.size
		},
	}
}
const provenPrivateDirectories = createDirectoryProofCache()

/**
 * The file's discretionary access-control list, as SDDL, or `null`.
 *
 * `null` off Windows and on any failure to read. Exported so a test can make
 * the Windows arm a real assertion instead of "the write did not throw" —
 * without it, deleting the entire protection step would kill no test on the
 * platform the protection is FOR, and the only coverage would be the POSIX
 * branch running somewhere else.
 *
 * `icacls /save` writes a UTF-16 file whose second line is the descriptor.
 * SDDL names principals by security identifier, so nothing here depends on
 * the machine's display language.
 */
export function readAclSddl(path: string): string | null {
	if (platform() !== 'win32') return null
	const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
	const aclPath = join(tmpdir(), `namzu-acl-${randomBytes(6).toString('hex')}`)
	try {
		execFileSync(
			join(system32, 'icacls.exe'),
			[toNamespacedPath(path), '/save', toNamespacedPath(aclPath)],
			{
				encoding: 'utf8',
				timeout: 10_000,
				stdio: ['ignore', 'pipe', 'ignore'],
				windowsHide: true,
			},
		)
		return readFileSync(aclPath, 'utf16le')
	} catch {
		return null
	} finally {
		rmSync(aclPath, { force: true })
	}
}

/** The current account's security identifier, or `null` off Windows / on failure. */
export function currentUserSid(): string | null {
	if (platform() !== 'win32') return null
	// The account a process runs as does not change while it runs, and asking costs a Windows
	// process each time. Only an answer is kept; a failure is asked again.
	if (knownUserSid) return knownUserSid
	const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
	try {
		const out = execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
			encoding: 'utf8',
			timeout: 10_000,
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true,
		})
		knownUserSid = out.match(/"(S-1-[0-9-]+)"/)?.[1]
		return knownUserSid ?? null
	} catch {
		return null
	}
}
let knownUserSid: string | undefined

/**
 * Require a protected SDDL discretionary ACL that grants the current account
 * access, with no other allowed principal except Windows LocalSystem.
 *
 * Split out from the spawning above because it is the actual assertion, and
 * an assertion that can only run on one operating system is an assertion
 * nobody checks. Every entry is examined, not just the first: an ACL reading
 * `(A;;FA;;;US)(A;;FA;;;WD)` grants us AND everyone, and a check that stopped
 * at a match would call that private.
 */
export function assertSoleOwnerSddl(sddl: string, sid: string, path: string): void {
	const dacl = sddl.match(/D:([A-Z]*)(.*?)(?=[OGS]:|[\r\n]|$)/u)
	const flags = dacl?.[1] ?? ''
	const body = dacl?.[2] ?? ''
	if (!dacl || !/^(?:\([^()]*\))+$/u.test(body)) {
		throw new CredentialStoreError(
			`the access-control list of ${path} could not be read back, so its privacy is unestablished.`,
		)
	}
	if (!flags.includes('P')) {
		throw new CredentialStoreError(
			`${path} still inherits permissions from its parent folder, so accounts other than yours may read it.`,
		)
	}
	const aces = [...body.matchAll(/\(([^)]*)\)/g)].map((m) => (m[1] ?? '').split(';'))
	if (aces.length === 0) {
		throw new CredentialStoreError(
			`the access-control list of ${path} could not be read back, so its privacy is unestablished.`,
		)
	}
	let grantsCurrentAccount = false
	const normalizeSid = (value: string): string =>
		value.toUpperCase() === 'SY' ? 'S-1-5-18' : value.toUpperCase()
	for (const ace of aces) {
		const type = ace[0] ?? ''
		const trustee = ace[5] ?? ''
		// Object/conditional ACEs need a different parser. They cannot be
		// classified as harmless merely because their type is not plain A.
		if (ace.length !== 6 || (type !== 'A' && type !== 'D') || ace[3] || ace[4]) {
			throw new CredentialStoreError(
				`the access-control list of ${path} contains an unsupported entry, so its privacy is unestablished.`,
			)
		}
		if (type === 'D') continue
		const currentAccount = normalizeSid(trustee) === normalizeSid(sid)
		if (!currentAccount && normalizeSid(trustee) !== 'S-1-5-18') {
			throw new CredentialStoreError(
				`${path} grants access to an account other than yours (${trustee}) — refusing to keep a credential there.`,
			)
		}
		// An inherit-only grant applies to descendants, not this path. A
		// SYSTEM-only list likewise says nothing about the current user's access.
		if (currentAccount && !(ace[1] ?? '').includes('IO') && ace[2]) {
			grantsCurrentAccount = true
		}
	}
	if (!grantsCurrentAccount) {
		throw new CredentialStoreError(
			`${path} ended with no access granted to your account, which is not a credential store — refusing.`,
		)
	}
}
