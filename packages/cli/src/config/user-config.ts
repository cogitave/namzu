/**
 * Write one key of the user config (`$NAMZU_HOME/config.yaml`), keeping the
 * rest of the file — comments, order, other keys — as the operator wrote it.
 *
 * For switches the operator flips from the terminal (`/skills save off`).
 * The file is parsed as a YAML document, the one path is set, and the result
 * is written through a temporary file and a rename. A file that does not
 * parse is refused rather than rewritten: rewriting it would drop whatever
 * the operator was in the middle of writing.
 *
 * The terminal and the Desktop engine both write this file, so each change
 * holds `config.yaml.lock` from its read to its rename, and the file as it was
 * is copied to `backups/config.yaml.backup.<ms>` first.
 */

import { randomUUID } from 'node:crypto'
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { backupStateFile } from '@namzu/sdk'
import { Document, isMap, parseDocument } from 'yaml'

import { restrictToOwner } from '../integrations/providers/credential-store.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import {
	newestStateBackup,
	recoveryCopySentence,
	withStateFileLock,
} from '../integrations/state/state-file.js'

export interface UserConfigWriteOptions {
	/** Override the user's home dir (testing). */
	readonly home?: string
	readonly env?: NodeJS.ProcessEnv
}

export function userConfigPath(opts: UserConfigWriteOptions = {}): string {
	return join(
		resolveNamzuHome({ ...(opts.home ? { home: opts.home } : {}), env: opts.env ?? process.env }),
		'config.yaml',
	)
}

/**
 * The refusal for a user config that does not read as settings, naming the
 * newest recovery copy when there is one. The file itself is left as it is.
 */
export function unreadableUserConfig(file: string, problem: string): Error {
	const copy = newestStateBackup(dirname(file), file)
	const recovery = copy ? ` ${recoveryCopySentence(file, copy, (path) => path)}` : ''
	return new Error(`${file} ${problem}; fix it first.${recovery}`)
}

function parseProblem(doc: Document): string | undefined {
	if (doc.errors.length > 0) return `is not valid YAML (${doc.errors[0]?.message ?? 'parse error'})`
	if (doc.contents !== null && !isMap(doc.contents)) return 'is not a mapping of settings'
	return undefined
}

/**
 * Run `operation` holding the user config's lock, so a change that reads the
 * file, checks it and then writes it is one change. The writers below take the
 * same lock inside, which is re-entrant, so they can be called from here.
 */
export function withUserConfigLock<T>(operation: () => T, opts: UserConfigWriteOptions = {}): T {
	return withStateFileLock(userConfigPath(opts), operation)
}

/**
 * Set `path` (for example `['skills', 'suggest']`) to `value` in the user
 * config and return the file written. Throws with a sentence naming the file
 * when it cannot be read as YAML or written.
 */
export function setUserConfigValue(
	path: readonly string[],
	value: unknown,
	opts: UserConfigWriteOptions = {},
): string {
	const file = userConfigPath(opts)
	return withStateFileLock(file, () => setValue(file, path, value))
}

function setValue(file: string, path: readonly string[], value: unknown): string {
	const exists = existsSync(file)
	const text = exists ? readFileSync(file, 'utf8') : ''
	const doc = text.trim().length > 0 ? parseDocument(text) : new Document({})
	const problem = parseProblem(doc)
	if (problem) throw unreadableUserConfig(file, problem)
	for (let depth = 1; depth < path.length; depth += 1) {
		const parent = doc.getIn(path.slice(0, depth), true)
		if (parent !== undefined && parent !== null && !isMap(parent)) {
			throw new Error(`${file}: ${path.slice(0, depth).join('.')} is not a mapping; fix it first`)
		}
	}
	doc.setIn(path, value)
	writePrivateUserConfig(file, doc)
	return file
}

/**
 * Change the user config as one document: `change` edits it in place (set and delete paths, as a
 * YAML document keeps comments and order) and the result is written once, so an edit that touches
 * several keys is never left half done. A file that does not parse is refused, not rewritten.
 */
export function editUserConfigDocument(
	change: (doc: Document) => void,
	opts: UserConfigWriteOptions = {},
): string {
	const file = userConfigPath(opts)
	return withStateFileLock(file, () => editDocument(file, change))
}

function editDocument(file: string, change: (doc: Document) => void): string {
	const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
	const doc = text.trim().length > 0 ? parseDocument(text) : new Document({})
	const problem = parseProblem(doc)
	if (problem) throw unreadableUserConfig(file, problem)
	change(doc)
	writePrivateUserConfig(file, doc)
	return file
}

/** Remove one user-owned setting while preserving the rest of the YAML document. */
export function deleteUserConfigValue(
	path: readonly string[],
	opts: UserConfigWriteOptions = {},
): boolean {
	const file = userConfigPath(opts)
	return withStateFileLock(file, () => deleteValue(file, path))
}

function deleteValue(file: string, path: readonly string[]): boolean {
	if (!existsSync(file)) return false
	const text = readFileSync(file, 'utf8')
	const doc = parseDocument(text)
	const problem = parseProblem(doc)
	if (problem) throw unreadableUserConfig(file, problem)
	for (let depth = 1; depth < path.length; depth += 1) {
		const parent = doc.getIn(path.slice(0, depth), true)
		if (parent === undefined || parent === null) return false
		if (!isMap(parent)) {
			throw new Error(`${file}: ${path.slice(0, depth).join('.')} is not a mapping; fix it first`)
		}
	}
	if (!doc.hasIn(path)) return false
	doc.deleteIn(path)
	// A block this removal left empty goes with it, so the file does not keep a bare `tui: {}`.
	for (let depth = path.length - 1; depth >= 1; depth -= 1) {
		const parentPath = path.slice(0, depth)
		const parent = doc.getIn(parentPath, true)
		if (!isMap(parent) || parent.items.length > 0) break
		doc.deleteIn(parentPath)
	}
	writePrivateUserConfig(file, doc)
	return true
}

/** Replacing an old config must never carry its broad mode onto a secret-bearing copy. */
function writePrivateUserConfig(file: string, doc: Document): void {
	const parent = dirname(file)
	mkdirSync(parent, { recursive: true, mode: 0o700 })
	if (platform() === 'win32') {
		const entry = lstatSync(parent)
		if (entry.isSymbolicLink() || !entry.isDirectory()) {
			throw new Error(`User config directory must be a real directory: ${parent}`)
		}
		// POSIX 0600 has no ACL meaning on Windows. Secure the parent before
		// opening a temp file and prove that file private while it is still empty.
		restrictToOwner(parent)
	}
	// The settings as they were, kept in backups/ before they are replaced.
	backupStateFile(file, { home: parent })
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
	let fd: number | undefined
	try {
		fd = openSync(temp, 'wx', 0o600)
		restrictToOwner(temp)
		writeFileSync(fd, doc.toString())
		fsyncSync(fd)
		closeSync(fd)
		fd = undefined
		restrictToOwner(temp)
		renameSync(temp, file)
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd)
			} catch {
				// The file remains private; still try to remove its name.
			}
		}
		try {
			rmSync(temp, { force: true })
		} catch (cleanupError) {
			throw new Error(`Private user-config temporary file could not be removed: ${temp}`, {
				cause: new AggregateError([error, cleanupError]),
			})
		}
		throw error
	}
}
