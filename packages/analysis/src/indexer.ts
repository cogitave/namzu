import { createHash } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { TextDecoder } from 'node:util'

import { lineStarts } from './lines.js'
import { ParserUnavailableError, isDeclarationFile, languageOf, parseSource } from './parse.js'
import type { Store } from './store.js'
import { RowSink, indexProgram } from './walk.js'

/** Directories never entered. Names, matched anywhere below the root. */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
	'node_modules',
	'.git',
	'.hg',
	'.svn',
	'.namzu',
	'.turbo',
	'.cache',
	'coverage',
]

export const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024
export const DEFAULT_MAX_FILES = 150_000

/** How long synchronous work may run before the event loop gets a turn. */
const SLICE_MS = 20
/** Files per transaction. A crash loses at most this many, never half of one. */
const BATCH_FILES = 200

const decoder = new TextDecoder('utf-8', { fatal: true })

export interface IndexOptions {
	readonly ignoreDirs: readonly string[]
	readonly maxFileBytes: number
	readonly maxFiles: number
	readonly force: boolean
}

export interface IndexOutcome {
	readonly parsed: number
	readonly unchanged: number
	readonly removed: number
	readonly skipped: number
	readonly skippedReasons: Record<string, number>
	readonly withParseErrors: number
	readonly indexed: number
	readonly changed: boolean
	readonly capped: boolean
}

export interface Candidate {
	readonly rel: string
	readonly abs: string
}

/**
 * Decode a file's bytes the way the index always does, or `undefined` when
 * they are not text.
 *
 * Strict UTF-8, so a binary file with a `.js` name is recognised by the bytes
 * rather than by trusting the name. A byte-order mark is stripped by the
 * decoder, and every offset in the index is relative to the stripped text —
 * which is why slices must be cut from text decoded by this same function.
 */
export function decodeText(buffer: Uint8Array): string | undefined {
	// A NUL in the first block is the quickest honest sign of a binary file,
	// and valid UTF-8 can still contain one.
	const head = Math.min(buffer.length, 8192)
	for (let i = 0; i < head; i++) if (buffer[i] === 0) return undefined
	try {
		return decoder.decode(buffer)
	} catch {
		return undefined
	}
}

export function hashOf(buffer: Uint8Array): string {
	return createHash('sha1').update(buffer).digest('hex')
}

/** Source files under `root`, as POSIX-separated relative paths, in a stable order. */
export async function collectFiles(
	root: string,
	options: Pick<IndexOptions, 'ignoreDirs' | 'maxFiles'>,
	skip: (reason: string) => void,
): Promise<{ files: Candidate[]; capped: boolean }> {
	const ignored = new Set(options.ignoreDirs)
	const files: Candidate[] = []
	const pending: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }]
	let capped = false
	let lastYield = performance.now()
	while (pending.length > 0 && !capped) {
		const dir = pending.pop() as { abs: string; rel: string }
		let entries: Dirent[]
		try {
			entries = await readdir(dir.abs, { withFileTypes: true })
		} catch {
			skip('unreadable directory')
			continue
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		const subdirs: Array<{ abs: string; rel: string }> = []
		for (const entry of entries) {
			const rel = dir.rel === '' ? entry.name : `${dir.rel}/${entry.name}`
			if (entry.isSymbolicLink()) {
				// A link can point anywhere, including out of the root. Not followed,
				// so the index never reads a file the walk did not find under it.
				if (languageOf(entry.name) !== undefined) skip('symbolic link')
				continue
			}
			if (entry.isDirectory()) {
				if (!ignored.has(entry.name)) subdirs.push({ abs: join(dir.abs, entry.name), rel })
				continue
			}
			if (!entry.isFile() || languageOf(entry.name) === undefined) continue
			if (isDeclarationFile(entry.name)) {
				skip('declaration file')
				continue
			}
			if (files.length >= options.maxFiles) {
				capped = true
				break
			}
			files.push({ rel, abs: join(dir.abs, entry.name) })
		}
		// Reverse so the stack pops them alphabetically.
		for (let i = subdirs.length - 1; i >= 0; i--)
			pending.push(subdirs[i] as (typeof subdirs)[number])
		if (performance.now() - lastYield > SLICE_MS) {
			await nextTurn()
			lastYield = performance.now()
		}
	}
	files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
	return { files, capped }
}

/**
 * Parse one file's text into rows and write them.
 *
 * Its own function so the syntax tree — tens of megabytes for a large bundle —
 * goes out of scope the moment the rows are written, instead of staying live
 * across the loop that calls this for the next file.
 */
async function parseAndWrite(
	store: Store,
	candidate: Candidate,
	text: string,
	stat: Pick<Stats, 'size' | 'mtimeMs'>,
	hash: string,
	nextFnId: number,
): Promise<{ nextFnId: number; parseErrors: number } | { error: string }> {
	let parsed: Awaited<ReturnType<typeof parseSource>>
	try {
		parsed = await parseSource(candidate.abs, text)
	} catch (err) {
		// The parser being absent is not this file's fault; let it end the run.
		if (err instanceof ParserUnavailableError) throw err
		return { error: err instanceof Error ? err.message : String(err) }
	}
	const sink = new RowSink(nextFnId)
	indexProgram(parsed.program as Parameters<typeof indexProgram>[0], sink)
	const starts = lineStarts(text)
	store.writeFile({
		path: candidate.rel,
		chars: text.length,
		lang: languageOf(candidate.abs) ?? 'js',
		parseErrors: parsed.errors,
		lineStarts: starts,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		hash,
		sink,
	})
	return { nextFnId: sink.next, parseErrors: parsed.errors }
}

/**
 * Bring the store up to date with `root`.
 *
 * Incremental in two steps, so the common case does the least work:
 *
 * 1. **Size and mtime** unchanged: the file is not read.
 * 2. Either changed: the file IS read and hashed. Same hash (a `touch`, a
 *    checkout that rewrote identical bytes) means no parse, only the new
 *    mtime recorded. A different hash means a re-parse.
 *
 * Files that vanished are removed. Work yields to the event loop every
 * {@link SLICE_MS}, so a host's UI stays responsive during a multi-second
 * first index.
 */
export async function refreshIndex(
	store: Store,
	root: string,
	options: IndexOptions,
): Promise<IndexOutcome> {
	const skippedReasons: Record<string, number> = {}
	const skip = (reason: string): void => {
		skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1
	}
	const { files, capped } = await collectFiles(root, options, skip)
	if (capped) skip(`over the ${options.maxFiles}-file limit`)
	const stored = store.storedFiles()
	const seen = new Set<string>()

	let parsed = 0
	let unchanged = 0
	let removed = 0
	let changed = false
	let nextFnId = Number(store.meta('next_fn_id') ?? '1')
	let inBatch = 0
	let lastYield = performance.now()

	store.exec('BEGIN')
	const commitBatch = (): void => {
		store.setMeta('next_fn_id', String(nextFnId))
		store.exec('COMMIT')
		store.exec('BEGIN')
		inBatch = 0
	}
	try {
		for (const candidate of files) {
			seen.add(candidate.rel)
			const before = stored.get(candidate.rel)
			let stat: Stats
			try {
				stat = await lstat(candidate.abs)
			} catch {
				skip('unreadable')
				continue
			}
			if (stat.size > options.maxFileBytes) {
				skip(`over the ${Math.round(options.maxFileBytes / 1048576)} MiB size limit`)
				if (before) {
					store.removeFile(before.id)
					stored.delete(candidate.rel)
					changed = true
				}
				continue
			}
			if (
				!options.force &&
				before &&
				before.size === stat.size &&
				before.mtimeMs === stat.mtimeMs
			) {
				unchanged++
				continue
			}
			let buffer: Uint8Array
			try {
				buffer = await readFile(candidate.abs)
			} catch {
				skip('unreadable')
				continue
			}
			const hash = hashOf(buffer)
			if (!options.force && before && before.hash === hash) {
				// Same bytes under a new timestamp. Record it so the cheap check
				// passes next time; there is nothing to parse.
				store
					.prepare('UPDATE files SET size = ?, mtime_ms = ? WHERE id = ?')
					.run(stat.size, stat.mtimeMs, before.id)
				unchanged++
				continue
			}
			const text = decodeText(buffer)
			if (text === undefined) {
				skip('binary or not UTF-8')
				if (before) {
					store.removeFile(before.id)
					changed = true
				}
				continue
			}
			if (before) store.removeFile(before.id)
			const outcome = await parseAndWrite(store, candidate, text, stat, hash, nextFnId)
			if ('error' in outcome) {
				skip('parser failure')
				if (before) changed = true
				continue
			}
			nextFnId = outcome.nextFnId
			parsed++
			changed = true
			if (++inBatch >= BATCH_FILES) commitBatch()
			if (performance.now() - lastYield > SLICE_MS) {
				await nextTurn()
				lastYield = performance.now()
			}
		}
		// Anything stored that the walk no longer found.
		for (const [path, file] of stored) {
			if (seen.has(path)) continue
			store.removeFile(file.id)
			removed++
			changed = true
		}
		store.setMeta('next_fn_id', String(nextFnId))
		store.exec('COMMIT')
	} catch (err) {
		try {
			store.exec('ROLLBACK')
		} catch {
			// No transaction left to roll back.
		}
		throw err
	}

	store.ensureIndexes()
	const counts = store.get(
		'SELECT count(*) AS indexed, coalesce(sum(parse_errors > 0), 0) AS bad FROM files',
	) as { indexed: number; bad: number }
	if (changed) store.bumpGeneration()
	store.setMeta('built', '1')
	store.setMeta('skipped', JSON.stringify(skippedReasons))
	store.setMeta('refreshed_at', new Date().toISOString())
	return {
		parsed,
		unchanged,
		removed,
		skipped: Object.values(skippedReasons).reduce((a, b) => a + b, 0),
		skippedReasons,
		withParseErrors: Number(counts.bad),
		indexed: Number(counts.indexed),
		changed,
		capped,
	}
}

/**
 * Re-read ONE file. Used when a query finds that the file changed on disk
 * after it was indexed.
 */
export async function refreshFile(
	store: Store,
	root: string,
	rel: string,
): Promise<'unchanged' | 'refreshed' | 'removed' | 'unreadable'> {
	const abs = join(root, ...rel.split('/'))
	const before = store.get('SELECT id, hash FROM files WHERE path = ?', rel) as
		| { id: number; hash: string }
		| undefined
	let stat: Stats
	let buffer: Uint8Array
	try {
		stat = await lstat(abs)
		buffer = await readFile(abs)
	} catch {
		if (before) {
			store.exec('BEGIN')
			store.removeFile(Number(before.id))
			store.bumpGeneration()
			store.exec('COMMIT')
		}
		return 'removed'
	}
	const hash = hashOf(buffer)
	if (before && before.hash === hash) {
		store
			.prepare('UPDATE files SET size = ?, mtime_ms = ? WHERE id = ?')
			.run(stat.size, stat.mtimeMs, Number(before.id))
		return 'unchanged'
	}
	const text = decodeText(buffer)
	store.exec('BEGIN')
	try {
		if (before) store.removeFile(Number(before.id))
		if (text === undefined) {
			store.bumpGeneration()
			store.exec('COMMIT')
			return 'unreadable'
		}
		const nextFnId = Number(store.meta('next_fn_id') ?? '1')
		const outcome = await parseAndWrite(store, { rel, abs }, text, stat, hash, nextFnId)
		if ('error' in outcome) {
			store.bumpGeneration()
			store.exec('COMMIT')
			return 'unreadable'
		}
		store.setMeta('next_fn_id', String(outcome.nextFnId))
		store.bumpGeneration()
		store.exec('COMMIT')
		return 'refreshed'
	} catch (err) {
		try {
			store.exec('ROLLBACK')
		} catch {
			// Nothing to roll back.
		}
		throw err
	}
}

/** Convert a path under `root` to the POSIX relative form the store keys on. */
export function toRel(root: string, abs: string): string | undefined {
	if (abs === root) return ''
	const prefix = root.endsWith(sep) ? root : root + sep
	if (!abs.startsWith(prefix)) return undefined
	return abs.slice(prefix.length).split(sep).join('/')
}
