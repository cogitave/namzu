import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { restrictToOwner } from '../providers/credential-store.js'

const PRIVATE_DIRECTORY_MODE = 0o700

/**
 * Create one generated-state partition without changing authored `.namzu`
 * content such as project commands and plugins.
 *
 * The partition is the privacy boundary: store files may inherit portable
 * defaults. POSIX parent traversal and inheritable Windows current-user ACLs
 * protect newly generated transcripts, memory and task state. Repairing a
 * Windows parent does not remove explicit grants on existing descendants.
 * Existing directories are
 * tightened too; otherwise upgrading would protect only newly-created repos.
 *
 * Symlinks are refused before chmod. Following a project-controlled
 * `.namzu/memory` link would both write state outside the project and chmod a
 * directory the caller did not name.
 */
export function ensurePrivateStateDirectory(stateRoot: string, segment: string): string {
	if (!/^[A-Za-z0-9_-]+$/u.test(segment)) {
		throw new Error(`Namzu state partition must be one safe path segment: ${segment}`)
	}
	mkdirSync(stateRoot, { recursive: true })
	const rootEntry = lstatSync(stateRoot)
	if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
		throw new Error(`Namzu state root must be a real directory: ${stateRoot}`)
	}

	const path = join(stateRoot, segment)
	mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
	const entry = lstatSync(path)
	if (entry.isSymbolicLink() || !entry.isDirectory()) {
		throw new Error(`Namzu state partition must be a real directory: ${path}`)
	}
	if (process.platform !== 'win32') chmodSync(path, PRIVATE_DIRECTORY_MODE)
	// POSIX reads back the tightened mode; Windows replaces inheritance with a
	// inheritable current-user ACL, permits an existing LocalSystem grant, and reads that
	// descriptor back. Windows chmod controls only the read-only attribute.
	restrictToOwner(path)
	return path
}
