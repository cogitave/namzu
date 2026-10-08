import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
	type FolderFingerprint,
	fingerprintChanges,
	folderFingerprint,
} from './folder-fingerprint.js'

const FILE_VERSION = 1
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_FOLDERS = 500

export interface TrustedFolderRecord extends FolderFingerprint {
	at: string
}

/**
 * The fingerprint of each folder as Desktop last trusted it, keyed by canonical path, in a file
 * of its own (`trusted-folders.json`). Holds hashes and entry names, never file contents.
 * A damaged file reads as empty: every folder is then baselined again on its next connect.
 */
export class TrustedFolderStore {
	private records: Record<string, TrustedFolderRecord>
	constructor(
		private readonly file: string,
		private readonly options: {
			now?: () => Date
			onError?: (error: unknown, operation: 'read' | 'write') => void
		} = {},
	) {
		this.records = this.read()
	}
	get(path: string): TrustedFolderRecord | undefined {
		return this.records[path]
	}
	set(path: string, fingerprint: FolderFingerprint): void {
		const next = { ...this.records }
		delete next[path]
		next[path] = { ...fingerprint, at: (this.options.now?.() ?? new Date()).toISOString() }
		const keys = Object.keys(next)
		for (const key of keys.slice(0, Math.max(0, keys.length - MAX_FOLDERS))) delete next[key]
		try {
			mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
			const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
			writeFileSync(temporary, JSON.stringify({ version: FILE_VERSION, folders: next }), {
				mode: 0o600,
			})
			renameSync(temporary, this.file)
		} catch (error) {
			this.options.onError?.(error, 'write')
		}
		this.records = next
	}
	private read(): Record<string, TrustedFolderRecord> {
		try {
			const text = readFileSync(this.file, 'utf8')
			if (text.length > MAX_FILE_BYTES) throw new Error('too large')
			const parsed = JSON.parse(text) as { folders?: Record<string, unknown> }
			const out: Record<string, TrustedFolderRecord> = {}
			for (const [path, value] of Object.entries(parsed.folders ?? {})) {
				const item = value as Partial<TrustedFolderRecord> | null
				if (
					item &&
					typeof item.digest === 'string' &&
					item.algo === 'sha256' &&
					typeof item.at === 'string' &&
					item.parts &&
					typeof item.parts === 'object' &&
					Object.values(item.parts).every((part) => typeof part === 'string')
				)
					out[path] = item as TrustedFolderRecord
			}
			return out
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.options.onError?.(error, 'read')
			return {}
		}
	}
}

/** What the operator asks about a folder; separate from the store so tests can fake it. */
export interface FolderTrustGuard {
	/**
	 * Phrases naming what changed in the folder's automatic settings since it was last trusted
	 * here, or an empty list. A folder with no record is baselined (trust on first use), and
	 * with the setting off the record is brought up to date and nothing is reported.
	 */
	check(path: string): Promise<string[]>
	/** Desktop granted trust to the folder as it is now. */
	record(path: string): Promise<void>
}

export function createFolderTrustGuard(deps: {
	store: Pick<TrustedFolderStore, 'get' | 'set'>
	enabled: () => boolean
	canonical?: (path: string) => string
	fingerprint?: (path: string) => Promise<FolderFingerprint>
}): FolderTrustGuard {
	const canonical = deps.canonical ?? ((path) => path)
	const fingerprint = deps.fingerprint ?? folderFingerprint
	return {
		async check(path) {
			const key = canonical(path)
			const now = await fingerprint(key)
			const stored = deps.store.get(key)
			if (!stored) {
				deps.store.set(key, now)
				return []
			}
			if (stored.digest === now.digest) return []
			if (!deps.enabled()) {
				deps.store.set(key, now)
				return []
			}
			const changes = fingerprintChanges(stored, now)
			return changes.length ? changes : ['automatic settings changed']
		},
		async record(path) {
			const key = canonical(path)
			deps.store.set(key, await fingerprint(key))
		},
	}
}
