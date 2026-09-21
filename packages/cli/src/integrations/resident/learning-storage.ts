import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteResidentLearningStore } from '@namzu/sdk'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'
import { type CliResident, residentDirectoryFor } from './storage.js'

/**
 * One database per resident agent, beside its runner state:
 * `projects/<slug>/residents/<agent-key>/learning.sqlite`, with the artifacts
 * it references in `artifacts/`. A database from the old installation-wide
 * location is never opened; the SDK refuses one at an older schema version.
 */
export function residentLearningStore(
	resident: CliResident,
	readOnly = false,
): SqliteResidentLearningStore | null {
	const agentRoot = residentDirectoryFor(resident.root, resident.slug, resident.agentKey)
	const databasePath = join(agentRoot, 'learning.sqlite')
	const artifactsPath = join(agentRoot, 'artifacts')
	if (readOnly) {
		for (const directory of [agentRoot, artifactsPath]) {
			if (!existsSync(directory)) continue
			const entry = lstatSync(directory)
			if (!entry.isDirectory() || entry.isSymbolicLink())
				throw new Error(`Learning state requires a real directory: ${directory}`)
		}
		if (!existsSync(databasePath)) return null
	} else {
		ensurePrivateStateDirectory(agentRoot, 'artifacts')
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
