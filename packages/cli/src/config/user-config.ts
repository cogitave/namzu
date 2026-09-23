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

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Document, isMap, parseDocument } from 'yaml'

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
	mkdirSync(dirname(file), { recursive: true })
	const temp = `${file}.${process.pid}.tmp`
	// The file keeps its own permissions; a new one is the owner's alone.
	writeFileSync(temp, doc.toString(), { mode: exists ? statSync(file).mode & 0o777 : 0o600 })
	renameSync(temp, file)
	return file
}
