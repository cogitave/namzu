/**
 * Read-only view of the API keys that `/auth` accounts hold in `accounts.json`.
 *
 * `accounts.json` is the one place an account's key is stored. The startup
 * readers (provider discovery, `/logout`, the Desktop key list) consult it
 * after `api-keys.json`, so a key added through `/auth` is found at the next
 * start without being copied into a second file.
 *
 * Only a plain account counts: one without a custom endpoint, whose key is
 * stored beside it. The oldest such account of a provider is the one startup
 * uses. Nothing here writes; the account registry stays the only writer.
 */

import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { namzuHomePath } from '../state/home.js'

export interface AccountKeyEntry {
	readonly accountId: string
	readonly provider: string
	readonly key: string
}

export function accountsFilePath(home?: string): string {
	return join(namzuHomePath(home), 'accounts.json')
}

/**
 * Every plain API-key account with a readable key, oldest first. A missing,
 * unreadable, linked or malformed file is "no accounts": the caller then falls
 * back to what it had, and nothing is lost because nothing here deletes.
 */
export function readAccountKeys(home?: string): AccountKeyEntry[] {
	const path = accountsFilePath(home)
	try {
		const entry = lstatSync(path)
		if (!entry.isFile() || entry.isSymbolicLink()) return []
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
		if (typeof parsed !== 'object' || parsed === null) return []
		const { accounts, keys } = parsed as { accounts?: unknown; keys?: unknown }
		if (!Array.isArray(accounts) || typeof keys !== 'object' || keys === null) return []
		const store = keys as Record<string, unknown>
		const found: Array<AccountKeyEntry & { createdAt: string }> = []
		for (const raw of accounts) {
			if (typeof raw !== 'object' || raw === null) continue
			const account = raw as Record<string, unknown>
			const source = account.source as { kind?: unknown; keyRef?: unknown } | undefined
			if (
				typeof account.id !== 'string' ||
				typeof account.provider !== 'string' ||
				account.baseUrl !== undefined ||
				source?.kind !== 'api-key' ||
				typeof source.keyRef !== 'string'
			)
				continue
			const key = Object.prototype.hasOwnProperty.call(store, source.keyRef)
				? store[source.keyRef]
				: undefined
			if (typeof key !== 'string' || !key.trim()) continue
			found.push({
				accountId: account.id,
				provider: account.provider,
				key,
				createdAt: typeof account.createdAt === 'string' ? account.createdAt : '',
			})
		}
		return found
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
			.map(({ accountId, provider, key }) => ({ accountId, provider, key }))
	} catch {
		return []
	}
}

/** The key startup uses for a provider when no startup file names one: the oldest plain account's. */
export function readAccountStartupKey(provider: string, home?: string): string | null {
	return readAccountKeys(home).find((entry) => entry.provider === provider)?.key ?? null
}
