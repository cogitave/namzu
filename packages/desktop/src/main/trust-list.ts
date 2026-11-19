import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TrustedFoldersView } from '../shared/storage-protocol.js'

const FILE_VERSION = 1
const MAX_FILE_BYTES = 4 * 1024 * 1024

/**
 * The list of folders the engine trusts: `trust.json` in the Namzu home. It is what decides whether
 * a folder may be used, and the command line reads it on every check, so a folder removed here asks
 * again at once. Desktop cannot import the command line, so it reads and writes the same file shape
 * (`{ version, trusted: string[] }`) itself. Desktop's own fingerprints are forgotten by the caller.
 */
export class EngineTrustList {
	readonly file: string
	constructor(
		namzuHome: string,
		private readonly onError?: (error: unknown, operation: 'read' | 'write') => void,
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
		const read = this.read()
		if (read.unreadable)
			throw new Error('The trusted folders list could not be read, so nothing was removed.')
		if (!read.folders.includes(path)) throw new Error('That folder is no longer on the list.')
		const kept = read.folders.filter((entry) => entry !== path)
		const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
		try {
			mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
			writeFileSync(
				temporary,
				`${JSON.stringify({ version: FILE_VERSION, trusted: kept }, null, 2)}\n`,
				{
					mode: 0o600,
				},
			)
			renameSync(temporary, this.file)
		} catch (error) {
			rmSync(temporary, { force: true })
			this.onError?.(error, 'write')
			throw new Error('The trusted folders list could not be saved, so nothing was removed.')
		}
		return { file: this.file, folders: kept }
	}
	private read(): { folders: string[]; unreadable?: boolean } {
		try {
			const text = readFileSync(this.file, 'utf8')
			if (text.length > MAX_FILE_BYTES) throw new Error('too large')
			const parsed = JSON.parse(text) as { trusted?: unknown }
			return {
				folders: Array.isArray(parsed.trusted)
					? parsed.trusted.filter((entry): entry is string => typeof entry === 'string')
					: [],
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { folders: [] }
			this.onError?.(error, 'read')
			return { folders: [], unreadable: true }
		}
	}
}
