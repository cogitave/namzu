import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'unread-conversations.json'

/**
 * The unread conversations, kept in a file of their own. `desktop-conversations.json` refuses a
 * key it does not know, so a new key there would make an older app refuse the whole file and lose
 * its drafts. This file is only read here; an older app never opens it.
 */
export function readUnreadFile(directory: string): string[] {
	try {
		const value: unknown = JSON.parse(readFileSync(join(directory, FILE), 'utf8'))
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
		const ids = (value as { ids?: unknown }).ids
		return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
	} catch {
		// Missing is the normal first start; a damaged file only costs the markers.
		return []
	}
}

/** Atomic: a temporary file, then a rename, mode 0600. Throws on failure; the caller reports it. */
export function writeUnreadFile(directory: string, ids: readonly string[]): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const file = join(directory, FILE)
	writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, ids }), { mode: 0o600 })
	renameSync(`${file}.tmp`, file)
}
