/**
 * One-time move of API keys that an earlier build kept only in `accounts.json`.
 *
 * Startup reads a provider's saved key from `api-keys.json` (Gemini: its own
 * file), but the account flow stored its keys in `accounts.json`, which the
 * provider list never consults. A person who added a key there found the
 * provider "not detected" on every start. This copies the first plain account
 * key of each such provider into the store startup reads, once, and leaves
 * `accounts.json` exactly as it was so every account keeps working.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { AccountRegistry } from '@namzu/sdk'

import { namzuHomePath } from '../state/home.js'
import { hasApiCredential } from './access.js'
import {
	readStoredApiKey,
	readStoredGeminiApiKey,
	writeStoredApiKey,
	writeStoredGeminiApiKey,
} from './credential-store.js'
import { PROVIDER_REGISTRY, type ProviderId } from './registry.js'

export function keyMigrationMarkerPath(home?: string): string {
	return join(namzuHomePath(home), '.api-keys-migrated')
}

/** Whether this provider's saved key (wherever it lives) already exists. */
function hasSavedKey(id: string, home?: string): boolean {
	return (id === 'google' ? readStoredGeminiApiKey(home) : readStoredApiKey(id, home)) !== null
}

/**
 * Copy account keys into the startup store. Returns the one-line notice to
 * show, or `null` when nothing moved. Runs once per home (a marker records
 * that), never prompts, never throws, and never touches `accounts.json`.
 */
export async function migrateAccountKeys(
	registry: AccountRegistry,
	options: { readonly home?: string; readonly labelOf?: (id: string) => string } = {},
): Promise<string | null> {
	const { home } = options
	const marker = keyMigrationMarkerPath(home)
	if (existsSync(marker)) return null
	const moved: string[] = []
	let incomplete = false
	try {
		const seen = new Set<string>()
		const accounts = registry
			.list()
			.filter((a) => a.source.kind === 'api-key' && a.baseUrl === undefined)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
		for (const account of accounts) {
			const id = account.provider
			if (seen.has(id)) continue
			seen.add(id)
			const entry = PROVIDER_REGISTRY[id as ProviderId]
			if (!entry?.constructible || !entry.acceptsTypedCredential) continue
			if (hasSavedKey(id, home)) continue
			try {
				const credential = await registry.resolve(account.id, new AbortController().signal)
				const key = credential.accessToken
				if (!hasApiCredential(entry, key)) continue
				if (id === 'google') writeStoredGeminiApiKey(key, home)
				else writeStoredApiKey(id, key, home)
				moved.push(options.labelOf?.(id) ?? entry.label)
			} catch {
				// One unreadable or unwritable account must not stop the rest, nor start.
				// It is not marked done, so the next start tries it again.
				incomplete = true
			}
		}
	} catch {
		return null
	}
	if (incomplete) return moved.length === 0 ? null : noticeFor(moved)
	try {
		mkdirSync(dirname(marker), { recursive: true, mode: 0o700 })
		writeFileSync(marker, '', { mode: 0o600 })
	} catch {
		// Without a marker the move is retried next start; every step is idempotent.
	}
	if (moved.length === 0) return null
	return noticeFor(moved)
}

function noticeFor(moved: readonly string[]): string {
	return `Moved your saved ${moved.join(', ')} API key from /auth accounts to the key store the provider list reads, so you are not asked again.`
}
