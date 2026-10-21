import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { TextDecoder } from 'node:util'

import { isInside, readRegular } from './fsafe.js'
import { type ParserHost, abortError } from './host.js'
import { lineStarts } from './lines.js'
import { isDeclarationFile, languageOf } from './parse.js'
import { CRASHED, type Store } from './store.js'
import { EMPTY_ROWS } from './walk.js'

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
/** Directories one call will walk. A home directory has more; see {@link IndexOptions.maxDirectories}. */
export const DEFAULT_MAX_DIRECTORIES = 20_000
/** Wall-clock one call will spend. */
export const DEFAULT_MAX_MILLIS = 45_000

/** How long synchronous work may run before the event loop gets a turn. */
const SLICE_MS = 20
/** Files per transaction. A crash loses at most this many, never half of one. */
const BATCH_FILES = 200
/** Violation / crash lists kept in the cache, for the words in coverage. */
const NAMED_LIMIT = 20

// `ignoreBOM`: keep U+FEFF in the text. Every offset the index reports is a
// position in the string `readFile(…, 'utf8')` returns, which is the string the
// `read` tool shows; stripping the mark would put every offset on line 1 one
// character off from it.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface IndexOptions {
	readonly ignoreDirs: readonly string[]
	readonly maxFileBytes: number
	readonly maxFiles: number
	/**
	 * Stop walking after this many directories. Not a refusal: what was
	 * indexed is kept and answered from, coverage says it is partial, and the
	 * next step is an index of a narrower path.
	 */
	readonly maxDirectories: number
	/** Stop after this long, with the same consequence. */
	readonly maxMillis: number
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
	/** Why the call stopped before covering its scope; absent when it covered it. */
	readonly truncated?: string
}

export interface Candidate {
	readonly rel: string
	readonly abs: string
}

/**
 * Decode a file's bytes the way the index always does, or `undefined` when
 * they are not text. Strict UTF-8, so a binary file with a `.js` name is
 * recognised by its bytes rather than its name.
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

/** Convert a path under `root` to the POSIX relative form the store keys on. */
export function toRel(root: string, abs: string): string | undefined {
	if (abs === root) return ''
	const prefix = root.endsWith(sep) ? root : root + sep
	if (!abs.startsWith(prefix)) return undefined
	return abs.slice(prefix.length).split(sep).join('/')
}

interface Budget {
	readonly started: number
	readonly options: IndexOptions
	readonly signal: AbortSignal | undefined
}

function checkAbort(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError()
}

function overTime(b: Budget): boolean {
	return performance.now() - b.started > b.options.maxMillis
}

interface Walk {
	readonly files: Candidate[]
	/** Directories visited, with their mtime, for the new-file check. */
	readonly dirs: Array<{ rel: string; mtimeMs: number }>
	/** Set when the walk itself stopped early; its listing is then incomplete. */
	truncated: string | undefined
}

/**
 * Source files at or under `start`, as POSIX-separated relative paths, in a
 * stable order. A file `start` is a walk of one.
 */
async function collect(
	root: string,
	start: string,
	b: Budget,
	skip: (reason: string) => void,
): Promise<Walk> {
	const walk: Walk = { files: [], dirs: [], truncated: undefined }
	const ignored = new Set(b.options.ignoreDirs)
	let first: import('node:fs').Stats
	try {
		first = await lstat(start)
	} catch {
		return walk
	}
	const startRel = toRel(root, start) ?? ''
	if (first.isSymbolicLink()) {
		skip('symbolic link')
		return walk
	}
	if (first.isFile()) {
		if (languageOf(start) !== undefined && !isDeclarationFile(start))
			walk.files.push({ rel: startRel, abs: start })
		return walk
	}
	if (!first.isDirectory()) return walk

	const pending: Array<{ abs: string; rel: string }> = [{ abs: start, rel: startRel }]
	let lastYield = performance.now()
	let visited = 0
	while (pending.length > 0) {
		checkAbort(b.signal)
		if (visited >= b.options.maxDirectories) {
			walk.truncated = `stopped after walking ${visited.toLocaleString('en-US')} directories`
			break
		}
		if (overTime(b)) {
			walk.truncated = `stopped after ${Math.round(b.options.maxMillis / 1000)} seconds`
			break
		}
		const dir = pending.pop() as { abs: string; rel: string }
		visited++
		let entries: Dirent[]
		try {
			entries = await readdir(dir.abs, { withFileTypes: true })
			walk.dirs.push({ rel: dir.rel, mtimeMs: (await lstat(dir.abs)).mtimeMs })
		} catch {
			skip('unreadable directory')
			continue
		}
		entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
		const subdirs: Array<{ abs: string; rel: string }> = []
		for (const entry of entries) {
			const rel = dir.rel === '' ? entry.name : `${dir.rel}/${entry.name}`
			if (entry.isSymbolicLink()) {
				// A link can point anywhere, including out of the root. Never followed.
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
			if (walk.files.length >= b.options.maxFiles) {
				walk.truncated = `stopped at the ${b.options.maxFiles.toLocaleString('en-US')}-file limit`
				break
			}
			walk.files.push({ rel, abs: join(dir.abs, entry.name) })
		}
		for (let i = subdirs.length - 1; i >= 0; i--)
			pending.push(subdirs[i] as (typeof subdirs)[number])
		if (walk.truncated) break
		if (performance.now() - lastYield > SLICE_MS) {
			await nextTurn()
			lastYield = performance.now()
		}
	}
	walk.files.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0))
	return walk
}

function jsonList(store: Store, key: string): string[] {
	try {
		const parsed = JSON.parse(store.meta(key) ?? '[]')
		return Array.isArray(parsed) ? (parsed as string[]) : []
	} catch {
		return []
	}
}

/** Remember a file by name for the words in coverage, bounded. */
export function noteNamed(store: Store, key: 'violations' | 'crashed', rel: string): void {
	const list = jsonList(store, key)
	if (!list.includes(rel)) store.setMeta(key, JSON.stringify([...list, rel].slice(-NAMED_LIMIT)))
}

export function unnote(store: Store, key: 'violations' | 'crashed', rel: string): void {
	const list = jsonList(store, key)
	if (list.includes(rel)) store.setMeta(key, JSON.stringify(list.filter((r) => r !== rel)))
}

/**
 * Bring the store up to date with `scope` (a path under `root`, or `root`).
 *
 * Incremental in two steps, so the common case does the least work:
 *
 * 1. **Size and mtime** unchanged: the file is not read.
 * 2. Either changed: the file IS read and hashed. Same hash (a `touch`, a
 *    checkout that rewrote identical bytes) means no parse, only the new
 *    mtime recorded. A different hash means a re-parse, in the child process.
 *
 * Files that vanished from the scope are removed; a file that is now a link,
 * or resolves outside the root, is removed AND named in coverage. A parser
 * crash on one file records that file with no rows and carries on with the
 * next. The call stops at its limits (directories, time) and says so; what it
 * indexed up to then is committed and kept.
 *
 * The caller holds the store's in-process lock; this takes the cross-process
 * write lock itself, in batches, so another process can interleave.
 */
export async function refreshIndex(
	store: Store,
	root: string,
	scopeAbs: string,
	options: IndexOptions,
	host: ParserHost,
	signal?: AbortSignal,
): Promise<IndexOutcome> {
	const skippedReasons: Record<string, number> = {}
	const skip = (reason: string): void => {
		skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1
	}
	const budget: Budget = { started: performance.now(), options, signal }
	const scopeRel = toRel(root, scopeAbs) ?? ''

	// Belt and braces: the scope is resolved by the caller, and still must not
	// lead outside the root by the time it is walked.
	try {
		if (!isInside(root, await realpath(scopeAbs))) {
			skip('path outside the root')
			return outcomeOf(store, skippedReasons, 0, 0, 0, false, undefined)
		}
	} catch {
		// A scope that no longer exists walks as empty; stored rows under it go.
	}

	const walk = await collect(root, scopeAbs, budget, skip)
	let truncated = walk.truncated
	const stored = store.storedFiles(scopeRel)
	const seen = new Set(walk.files.map((f) => f.rel))

	let parsed = 0
	let unchanged = 0
	let removed = 0
	let changed = false
	let inBatch = 0
	let lastYield = performance.now()
	let open = false
	const begin = async (): Promise<void> => {
		await store.begin(signal)
		open = true
	}
	const end = (): void => {
		if (open) store.commit()
		open = false
	}
	const next = async (): Promise<void> => {
		end()
		await begin()
		inBatch = 0
	}

	await begin()
	try {
		if (scopeRel === '') store.setMeta('violations', '[]')
		for (const candidate of walk.files) {
			checkAbort(signal)
			if (overTime(budget)) {
				truncated ??= `stopped after ${Math.round(options.maxMillis / 1000)} seconds`
				break
			}
			const before = stored.get(candidate.rel)

			let lst: import('node:fs').Stats
			try {
				lst = await lstat(candidate.abs)
			} catch {
				skip('unreadable')
				continue
			}
			if (!lst.isFile()) {
				// Replaced by a link (or anything but a regular file) since the walk.
				skip('replaced by a link or not a regular file')
				if (before) {
					store.removeFile(before.id)
					noteNamed(store, 'violations', candidate.rel)
					changed = true
				}
				seen.delete(candidate.rel)
				continue
			}
			if (lst.size > options.maxFileBytes) {
				skip(`over the ${Math.round(options.maxFileBytes / 1048576)} MiB size limit`)
				if (before) {
					store.removeFile(before.id)
					changed = true
				}
				continue
			}
			if (!options.force && before && before.size === lst.size && before.mtimeMs === lst.mtimeMs) {
				unchanged++
				continue
			}
			const read = await readRegular(root, candidate.abs)
			if (!read.ok) {
				if (read.why === 'link' || read.why === 'outside' || read.why === 'not-file') {
					skip('replaced by a link or not a regular file')
					if (before) {
						store.removeFile(before.id)
						noteNamed(store, 'violations', candidate.rel)
						changed = true
					}
					seen.delete(candidate.rel)
				} else skip('unreadable')
				continue
			}
			const hash = hashOf(read.buffer)
			if (!options.force && before && before.hash === hash) {
				// Same bytes under a new timestamp. Record it so the cheap check
				// passes next time; there is nothing to parse.
				store
					.prepare('UPDATE files SET size = ?, mtime_ms = ? WHERE id = ?')
					.run(read.stat.size, read.stat.mtimeMs, before.id)
				unchanged++
				continue
			}
			const text = decodeText(read.buffer)
			if (text === undefined) {
				skip('binary or not UTF-8')
				if (before) {
					store.removeFile(before.id)
					changed = true
				}
				continue
			}

			const result = await host.parse({ rel: candidate.rel, abs: candidate.abs, text }, signal)
			const base = {
				path: candidate.rel,
				chars: text.length,
				lang: languageOf(candidate.abs) ?? 'js',
				lineStarts: lineStarts(text),
				size: read.stat.size,
				mtimeMs: read.stat.mtimeMs,
				hash,
			}
			if (result.kind === 'rows') {
				store.writeFile({ ...base, parseErrors: result.parseErrors, rows: result.rows })
				unnote(store, 'crashed', candidate.rel)
				parsed++
			} else if (result.kind === 'crash') {
				// Recorded with no rows and the stat it crashed at, so the next
				// refresh leaves it alone instead of crashing the child again.
				store.writeFile({ ...base, parseErrors: CRASHED, rows: EMPTY_ROWS })
				noteNamed(store, 'crashed', candidate.rel)
				skip('parser crashed')
			} else {
				store.writeFile({ ...base, parseErrors: 1, rows: EMPTY_ROWS })
				skip('parser failure')
			}
			changed = true
			if (++inBatch >= BATCH_FILES) await next()
			if (performance.now() - lastYield > SLICE_MS) {
				await nextTurn()
				lastYield = performance.now()
			}
		}

		// Anything stored under the scope that the walk no longer found — but only
		// when the walk finished, or a partial listing would delete the rest.
		if (!walk.truncated) {
			for (const [path, file] of stored) {
				if (seen.has(path)) continue
				const gone = await lstat(join(root, ...path.split('/'))).catch(() => undefined)
				store.removeFile(file.id)
				if (gone?.isSymbolicLink()) noteNamed(store, 'violations', path)
				removed++
				changed = true
			}
			// Directory mtimes, for noticing files created after this index.
			const prefix = scopeRel === '' ? null : scopeRel
			if (prefix === null) store.exec('DELETE FROM dirs')
			else
				store
					.prepare('DELETE FROM dirs WHERE path = ? OR (path >= ? AND path < ?)')
					.run(prefix, `${prefix}/`, `${prefix}0`)
			const insDir = store.prepare('INSERT OR REPLACE INTO dirs(path, mtime_ms) VALUES(?, ?)')
			for (const d of walk.dirs) insDir.run(d.rel, d.mtimeMs)
		}
		// Bookkeeping inside the same transaction, under the same lock.
		store.ensureIndexes()
		if (changed) store.bumpGeneration()
		recordCoverage(store, scopeRel, skippedReasons, truncated)
		end()
	} catch (err) {
		// An abort keeps what is already done; anything else is rolled back.
		if (open && err instanceof Error && err.name === 'AbortError') end()
		else {
			store.rollback()
			open = false
		}
		throw err
	}

	return outcomeOf(store, skippedReasons, parsed, unchanged, removed, changed, truncated)
}

function outcomeOf(
	store: Store,
	skippedReasons: Record<string, number>,
	parsed: number,
	unchanged: number,
	removed: number,
	changed: boolean,
	truncated: string | undefined,
): IndexOutcome {
	const counts = store.get(
		'SELECT count(*) AS indexed, coalesce(sum(parse_errors > 0), 0) AS bad FROM files',
	) as { indexed: number; bad: number }
	return {
		parsed,
		unchanged,
		removed,
		skipped: Object.values(skippedReasons).reduce((a, b) => a + b, 0),
		skippedReasons,
		withParseErrors: Number(counts.bad),
		indexed: Number(counts.indexed),
		changed,
		...(truncated ? { truncated } : {}),
	}
}

/** One scope that has been indexed, and whether the call covered all of it. */
export interface Covered {
	readonly s: string
	/** 1 when the call finished, 0 when it stopped at a limit. */
	readonly c: 0 | 1
	readonly r?: string
}

const MAX_COVERED_ENTRIES = 200

export function readCovered(store: Store): Covered[] {
	try {
		const parsed = JSON.parse(store.meta('covered') ?? '[]')
		return Array.isArray(parsed) ? (parsed as Covered[]) : []
	} catch {
		return []
	}
}

/** The entry that covers `scopeRel`: the same scope, an ancestor of it, or the whole root. */
export function coveringEntry(covered: readonly Covered[], scopeRel: string): Covered | undefined {
	return covered.find((e) => e.s === '' || e.s === scopeRel || scopeRel.startsWith(`${e.s}/`))
}

function recordCoverage(
	store: Store,
	scopeRel: string,
	skipped: Record<string, number>,
	truncated: string | undefined,
): void {
	const mine: Covered = {
		s: scopeRel,
		c: truncated ? 0 : 1,
		...(truncated ? { r: truncated } : {}),
	}
	let covered = readCovered(store)
	if (scopeRel === '') {
		// A whole-root run supersedes every narrower one, and its skip counts
		// replace theirs.
		covered = [mine]
		store.setMeta('skipped', JSON.stringify({ '': skipped }))
		// Violations found in this run are re-noted by it; older ones are stale.
	} else {
		const without = covered.filter((e) => e.s !== scopeRel)
		covered = without.length < MAX_COVERED_ENTRIES ? [...without, mine] : without
		let all: Record<string, Record<string, number>> = {}
		try {
			all = JSON.parse(store.meta('skipped') ?? '{}') as typeof all
		} catch {
			all = {}
		}
		all[scopeRel] = skipped
		store.setMeta('skipped', JSON.stringify(all))
	}
	store.setMeta('covered', JSON.stringify(covered))
	store.setMeta('refreshed_at', new Date().toISOString())
}
