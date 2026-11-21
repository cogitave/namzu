import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TrustedFoldersView } from '../shared/storage-protocol.js'
import {
	EngineStateFileBusyError,
	backupEngineStateFile,
	withEngineStateLock,
	writeEngineStateFile,
} from './engine-state-file.js'

const FILE_VERSION = 1
const MAX_FILE_BYTES = 4 * 1024 * 1024

/**
 * The list of folders the engine trusts: `trust.json` in the Namzu home. It is what decides whether
 * a folder may be used, and the command line reads it on every check, so a folder removed here asks
 * again at once. Desktop cannot import the command line, so it reads and writes the same file shape
 * (`{ version, trusted: string[] }`) itself, under the same lock, with the same recovery copy
 * first (see `engine-state-file.ts`). Desktop's own fingerprints are forgotten by the caller.
 */
export class EngineTrustList {
	readonly file: string
	constructor(
		private readonly namzuHome: string,
		private readonly onError?: (error: unknown, operation: 'read' | 'write') => void,
		private readonly lockWait?: (attempt: number) => void,
	) {
		this.file = join(namzuHome, 'trust.json')
	}
	view(): TrustedFoldersView {
		const read = this.read()
		return {
			file: this.file,
			folders: read.folders,
			...(read.unreadable ? { unreadable: true } : {}),
		}
	}
	/**
	 * Takes the entry named exactly `path` off the list. An entry that is not there is refused, so a
	 * stale view cannot remove something else. Entries that cover it (a parent) are never touched.
	 */
	remove(path: unknown): TrustedFoldersView {
		if (typeof path !== 'string' || !path) throw new Error('Invalid folder.')
		const lockOptions = this.lockWait ? { wait: this.lockWait } : {}
		try {
			// Read again under the lock: the command line may have added a folder since the view.
			return withEngineStateLock(this.file, () => this.removeLocked(path), lockOptions)
		} catch (error) {
			if (error instanceof EngineStateFileBusyError) throw new Error(error.message)
			throw error
		}
	}
	private removeLocked(path: string): TrustedFoldersView {
		const read = this.read()
		if (read.unreadable)
			throw new Error('The trusted folders list could not be read, so nothing was removed.')
		if (!read.folders.includes(path)) throw new Error('That folder is no longer on the list.')
		const kept = read.folders.filter((entry) => entry !== path)
		// Entries Desktop does not show (not text) and keys it does not know stay as written.
		const entries = read.entries.filter((entry) => entry !== path)
		try {
			backupEngineStateFile(this.file, this.namzuHome)
			writeEngineStateFile(
				this.file,
				`${JSON.stringify({ ...read.rest, version: FILE_VERSION, trusted: entries }, null, 2)}\n`,
			)
		} catch (error) {
			this.onError?.(error, 'write')
			throw new Error('The trusted folders list could not be saved, so nothing was removed.')
		}
		return { file: this.file, folders: kept }
	}
	private read(): {
		folders: string[]
		entries: unknown[]
		rest: Record<string, unknown>
		unreadable?: boolean
	} {
		try {
			const text = readFileSync(this.file, 'utf8')
			if (text.length > MAX_FILE_BYTES) throw new Error('too large')
			const parsed: unknown = JSON.parse(text)
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
				throw new Error('not a trust list')
			const { trusted, ...rest } = parsed as Record<string, unknown>
			const version = rest.version
			if (version !== undefined && (typeof version !== 'number' || version > FILE_VERSION))
				throw new Error('a newer list')
			if (trusted !== undefined && !Array.isArray(trusted)) throw new Error('not a list')
			const entries: unknown[] = trusted ?? []
			return {
				folders: entries.filter((entry): entry is string => typeof entry === 'string'),
				entries,
				rest,
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
				return { folders: [], entries: [], rest: {} }
			this.onError?.(error, 'read')
			return { folders: [], entries: [], rest: {}, unreadable: true }
		}
	}
}
