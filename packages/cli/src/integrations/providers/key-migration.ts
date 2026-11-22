/**
 * One-time retirement of the second copy of an API key.
 *
 * An earlier build copied the key of an `/auth` account into `api-keys.json`
 * (Gemini: its own file) so the provider list would find it, leaving the same
 * secret in two files: rotating or deleting it in one left the other behind.
 * `accounts.json` now owns an account's key and startup reads it from there,
 * so a copy that is byte for byte the account's key carries nothing the
 * account does not. This removes such copies.
 *
 * Called from the terminal app's start only; the Desktop key list and the
 * non-interactive commands read through the account fallback and so show one
 * key either way, and the copy goes at the next terminal start.
 *
 * Nothing is removed unless the account file is read first, its key equals the
 * copy exactly, and the removal itself checks the copy is still that value
 * under the store lock, then the account is read again and the copy is written back if the
 * account is gone. A key that differs from the account's is a different
 * key and stays. An unreadable or corrupt file on either side removes nothing.
 */

import { readAccountKeys } from './account-keys.js'
import {
	clearStoredApiKeyIf,
	clearStoredGeminiApiKeyIf,
	readOwnStoredApiKey,
	readStoredGeminiApiKey,
	writeStoredApiKey,
	writeStoredGeminiApiKey,
} from './credential-store.js'

export interface KeyRetirement {
	/** Provider ids whose duplicate copy was removed. */
	readonly retired: readonly string[]
}

/**
 * Remove each startup copy that duplicates an account's key. Idempotent, never
 * throws, and safe to run from two processes at once: the loser finds the copy
 * already gone and removes nothing.
 */
export function retireDuplicateStartupKeys(home?: string): KeyRetirement {
	const retired: string[] = []
	try {
		const accounts = readAccountKeys(home)
		const providers = new Set(accounts.map((entry) => entry.provider))
		for (const provider of providers) {
			// The oldest plain account is the one startup would use, so a copy is
			// a duplicate only of that key; a different key stays.
			const accountKey = accounts.find((entry) => entry.provider === provider)?.key
			if (accountKey === undefined) continue
			try {
				const google = provider === 'google'
				const own = google ? readStoredGeminiApiKey(home) : readOwnStoredApiKey(provider, home)
				if (own !== accountKey) continue
				const removed = google
					? clearStoredGeminiApiKeyIf(accountKey, home)
					: clearStoredApiKeyIf(provider, accountKey, home)
				if (!removed) continue
				// The account file was read before the removal, without its lock. If the
				// account went in between, this copy was the last one: put it back.
				const stillHeld = readAccountKeys(home).some(
					(entry) => entry.provider === provider && entry.key === accountKey,
				)
				if (stillHeld) retired.push(provider)
				else if (google) writeStoredGeminiApiKey(accountKey, home)
				else writeStoredApiKey(provider, accountKey, home)
			} catch {
				// Keep both copies; the next start looks again.
			}
		}
	} catch {
		return { retired }
	}
	return { retired }
}

export function retirementNotice(
	retired: readonly string[],
	labelOf: (id: string) => string,
): string | null {
	if (retired.length === 0) return null
	return `Your saved ${retired.map(labelOf).join(', ')} API key was stored twice. It is now kept once, with its account, and works as before. Removing that account removes the key.`
}
