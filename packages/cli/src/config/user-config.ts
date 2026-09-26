/**
 * Write one key of the user config (`$NAMZU_HOME/config.yaml`), keeping the
 * rest of the file — comments, order, other keys — as the operator wrote it.
 *
 * For switches the operator flips from the terminal (`/skills save off`).
 * The file is parsed as a YAML document, the one path is set, and the result
 * is written through a temporary file and a rename. A file that does not
 * parse is refused rather than rewritten: rewriting it would drop whatever
 * the operator was in the middle of writing.
 */

import { randomUUID } from 'node:crypto'
import {
	closeSync,
	existsSync,
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
import { Document, isMap, parseDocument } from 'yaml'

import { restrictToOwner } from '../integrations/providers/credential-store.js'
import { resolveNamzuHome } from '../integrations/state/home.js'

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
	const exists = existsSync(file)
	const text = exists ? readFileSync(file, 'utf8') : ''
	const doc = text.trim().length > 0 ? parseDocument(text) : new Document({})
	if (doc.errors.length > 0) {
		throw new Error(
			`${file} is not valid YAML (${doc.errors[0]?.message ?? 'parse error'}); fix it first`,
		)
	}
	if (doc.contents !== null && !isMap(doc.contents)) {
		throw new Error(`${file} is not a mapping of settings; fix it first`)
	}
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

/** Remove one user-owned setting while preserving the rest of the YAML document. */
export function deleteUserConfigValue(
	path: readonly string[],
	opts: UserConfigWriteOptions = {},
): boolean {
	const file = userConfigPath(opts)
	if (!existsSync(file)) return false
	const text = readFileSync(file, 'utf8')
	const doc = parseDocument(text)
	if (doc.errors.length > 0) {
		throw new Error(
			`${file} is not valid YAML (${doc.errors[0]?.message ?? 'parse error'}); fix it first`,
		)
	}
	if (doc.contents !== null && !isMap(doc.contents)) {
		throw new Error(`${file} is not a mapping of settings; fix it first`)
	}
	for (let depth = 1; depth < path.length; depth += 1) {
		const parent = doc.getIn(path.slice(0, depth), true)
		if (parent === undefined || parent === null) return false
		if (!isMap(parent)) {
			throw new Error(`${file}: ${path.slice(0, depth).join('.')} is not a mapping; fix it first`)
		}
	}
	if (!doc.hasIn(path)) return false
	doc.deleteIn(path)
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
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
	let fd: number | undefined
	try {
		fd = openSync(temp, 'wx', 0o600)
		restrictToOwner(temp)
		writeFileSync(fd, doc.toString())
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
