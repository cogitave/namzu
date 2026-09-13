import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteResidentLearningStore } from '@namzu/sdk'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'
import type { CliResident } from './storage.js'

/** One installation database; SQL scope replaces a directory/index per experiment. */
export function residentLearningStore(
	resident: CliResident,
	readOnly = false,
): SqliteResidentLearningStore | null {
	const databasePath = join(resident.root, 'state', 'learning.sqlite')
	const learningRoot = join(resident.root, 'learning')
	const artifactsPath = join(learningRoot, 'artifacts')
	if (readOnly) {
		for (const directory of [join(resident.root, 'state'), learningRoot, artifactsPath]) {
			if (!existsSync(directory)) continue
			const entry = lstatSync(directory)
			if (!entry.isDirectory() || entry.isSymbolicLink())
				throw new Error(`Learning state requires a real directory: ${directory}`)
		}
		if (!existsSync(databasePath)) return null
	} else {
		ensurePrivateStateDirectory(resident.root, 'state')
		ensurePrivateStateDirectory(resident.root, 'learning')
		ensurePrivateStateDirectory(learningRoot, 'artifacts')
	}
	for (const file of [
		databasePath,
		`${databasePath}-journal`,
		`${databasePath}-wal`,
		`${databasePath}-shm`,
	]) {
		let entry: ReturnType<typeof lstatSync>
		try {
			entry = lstatSync(file)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
			throw error
		}
		if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
			throw new Error(`Learning database requires a private regular file: ${file}`)
	}
	return new SqliteResidentLearningStore({
		databasePath,
		artifactsPath,
		scope: resident,
		readOnly,
	})
}
