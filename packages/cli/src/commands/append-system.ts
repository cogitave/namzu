/**
 * `--append-system-prompt <text|@file>`: standing instructions for one run.
 *
 * The text lands in the uncached tail of the system prompt, after everything
 * the cache keeps, so passing it never costs a cache miss on the shared
 * prefix. A leading `@` names a file to read; any other value is the text.
 * Relative paths resolve against the process's directory, like every other
 * path on the command line.
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/** Characters of appended instructions one run may carry. */
export const MAX_APPEND_SYSTEM_CHARS = 100_000

export type AppendSystemResult = { readonly text: string } | { readonly error: string } | undefined

/** The appended instructions a flag value names, or why they cannot be used. */
export function resolveAppendSystemPrompt(
	raw: string | null,
	base: string = process.cwd(),
): AppendSystemResult {
	if (raw === null) return undefined
	let text = raw
	if (raw.startsWith('@')) {
		const requested = raw.slice(1).trim()
		if (!requested) return { error: '--append-system-prompt @ needs a file name after the @' }
		const path = resolve(base, requested)
		try {
			if (!statSync(path).isFile()) return { error: `--append-system-prompt ${path} is not a file` }
			text = readFileSync(path, 'utf8')
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			return { error: `--append-system-prompt could not read ${path}: ${reason}` }
		}
	}
	text = text.trim()
	if (!text) return { error: '--append-system-prompt is empty' }
	if (text.length > MAX_APPEND_SYSTEM_CHARS)
		return {
			error: `--append-system-prompt is ${text.length.toLocaleString('en-US')} characters; the limit is ${MAX_APPEND_SYSTEM_CHARS.toLocaleString('en-US')}`,
		}
	return { text }
}
