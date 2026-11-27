/**
 * Small JSON files that hold a mapping and are changed by more than one Namzu
 * process: the install records and the settings files that carry the plugin
 * records. Everything here goes through `state/state-file.ts`: one change at a
 * time under the file's lock, a recovery copy first, and no overwrite of a file
 * that exists but does not read.
 *
 * A change is handed the file's mapping as written, so a key this Namzu does
 * not know (another tool's, a newer writer's) is kept as it was.
 */

import { readFileSync } from 'node:fs'

import {
	readFailureReason,
	saveStateFile,
	startNewStateFile,
	unreadableStateFile,
	withStateFileLock,
} from '../state/state-file.js'

export type JsonObjectRead =
	| { readonly state: 'missing' }
	| { readonly state: 'ok'; readonly raw: Readonly<Record<string, unknown>> }
	| { readonly state: 'unreadable'; readonly reason: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A file's top-level mapping. `check` returns a reason when the mapping is not
 * the shape the file must have; the file then reads as unreadable, never as
 * empty.
 */
export function readJsonObject(
	path: string,
	check?: (raw: Record<string, unknown>) => string | undefined,
): JsonObjectRead {
	let text: string
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
		return { state: 'unreadable', reason: readFailureReason(error) }
	}
	// A write cut short before its first byte: nothing in it to protect.
	if (text.trim() === '') return { state: 'missing' }
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		return { state: 'unreadable', reason: readFailureReason(error) }
	}
	if (!isRecord(parsed)) return { state: 'unreadable', reason: 'it is not a mapping' }
	const reason = check?.(parsed)
	if (reason !== undefined) return { state: 'unreadable', reason }
	return { state: 'ok', raw: parsed }
}

export interface JsonUpdateOptions {
	/** The Namzu home, whose `backups/` holds the recovery copies. */
	readonly home: string
	readonly check?: (raw: Record<string, unknown>) => string | undefined
	/** The mapping a missing file starts as. */
	readonly empty?: () => Record<string, unknown>
	/** The way out the refusal names when the file does not read. */
	readonly remedy?: string
}

/**
 * Change one file: under its lock, read it again, hand the mapping to
 * `mutate` (a copy it may change) and write the result whole. A file that
 * exists but does not read is never replaced: the refusal names where its
 * bytes are kept. `mutate` returns `false` to say nothing changed, and then
 * nothing is written.
 */
export function updateJsonObject(
	path: string,
	options: JsonUpdateOptions,
	mutate: (raw: Record<string, unknown>) => boolean | undefined,
): boolean {
	return withStateFileLock(path, () => {
		const read = readJsonObject(path, options.check)
		if (read.state === 'unreadable')
			throw unreadableStateFile(path, read.reason, options.home, options.remedy)
		const next: Record<string, unknown> =
			read.state === 'ok' ? { ...read.raw } : (options.empty?.() ?? {})
		if (mutate(next) === false) return false
		saveStateFile(path, `${JSON.stringify(next, null, 2)}\n`, { home: options.home })
		return true
	})
}

/**
 * Start a new file in place of one that does not read, for a person who chose
 * to. The old bytes are kept first; returns where, or `undefined` when the file
 * reads (or is missing) and so was left as it is.
 */
export function startNewJsonObject(
	path: string,
	options: JsonUpdateOptions & { readonly fresh: () => Record<string, unknown> },
): string | undefined {
	return withStateFileLock(path, () => {
		if (readJsonObject(path, options.check).state !== 'unreadable') return undefined
		return startNewStateFile(path, `${JSON.stringify(options.fresh(), null, 2)}\n`, options.home)
	})
}
