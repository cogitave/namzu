import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteSessionStore } from '@namzu/sdk'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'

export function sessionDatabasePath(root: string): string {
	return join(root, 'state', 'sessions.sqlite')
}

/** Readers never mint state. The private parent also confines SQLite's journal files. */
export function sessionStore(root: string, readOnly = false): SqliteSessionStore {
	if (!readOnly) ensurePrivateStateDirectory(root, 'state')
	const path = sessionDatabasePath(root)
	if (readOnly) {
		const parent = lstatSync(join(root, 'state'))
		if (!parent.isDirectory() || parent.isSymbolicLink())
			throw new Error('Session database requires a real state directory')
	}
	for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
		let entry: ReturnType<typeof lstatSync>
		try {
			entry = lstatSync(file)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
			throw error
		}
		if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
			throw new Error(`Session database requires a private regular file: ${file}`)
		}
	}

	return new SqliteSessionStore({ databasePath: path, readOnly })
}
