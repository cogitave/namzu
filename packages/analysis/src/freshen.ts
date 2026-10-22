import { type Stats, lstatSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { isExtensionless, shebangOf } from './collect.js'
import type { Env } from './context.js'
import { refreshIndex, toRel } from './indexer.js'
import { languageOf } from './parse.js'

/**
 * Answer from the files as they are now, not as they were when indexed.
 *
 * Checking only the files a query RETURNS (what `checkFreshness` does) cannot
 * catch the answer that matters most to an agent that edits code: "no hits".
 * An edit that adds the string, a new function that calls the name, a file
 * created beside the others — none of them is among the rows, so the answer
 * was `0` with coverage `complete`, and wrong.
 *
 * So a query that searches a scope first compares the scope with the disk:
 *
 * - every file recorded under it, by `lstat`: size and mtime, no read;
 * - every directory recorded under it, by `lstat`: an entry created, removed
 *   or renamed in it moves its mtime;
 * - for a single path that is not recorded at all, whether it is a source file
 *   that now exists.
 *
 * What it does with a difference is one rule, stated in the documentation:
 *
 * > **When at most {@link FEW_FILES} files and {@link FEW_DIRS} directories
 * > differ, and the changed files total at most {@link FEW_BYTES}, they are
 * > re-indexed before the query runs. Otherwise nothing is re-read, and the
 * > coverage of the answer says how many files changed so it is `partial`.**
 *
 * The first half keeps a query fast and correct after an edit; the second keeps
 * a query from turning into a surprise full index after a `git checkout` that
 * rewrote thousands of files — that one is the `index` operation's job, and the
 * answer says so.
 */
export const FEW_FILES = 25
export const FEW_DIRS = 25
export const FEW_BYTES = 16 * 1024 * 1024
/** Entries compared per query before it says it stopped. */
const MAX_FILES_CHECKED = 250_000
const MAX_DIRS_CHECKED = 20_000
/** Synchronous `lstat`s run this long before the event loop gets a turn. */
const SLICE_MS = 4

export interface Freshened {
	/** What the query did to make its answer current; goes into `observed`. */
	readonly notes: string[]
	/** Why the answer may still be out of date; goes into coverage. */
	readonly gaps: string[]
}

function scopeWhere(column: string, scopeRel: string): { sql: string; params: string[] } {
	if (scopeRel === '') return { sql: '', params: [] }
	return {
		sql: ` WHERE ${column} = ? OR (${column} >= ? AND ${column} < ?)`,
		params: [scopeRel, `${scopeRel}/`, `${scopeRel}0`],
	}
}

/**
 * `lstat` every path, in slices.
 *
 * Synchronous on purpose: 2,434 of them take 7 ms this way and 47 ms through
 * the promise API, whose cost is the thread pool round trip, not the system
 * call. Run in slices of {@link SLICE_MS} so a tree of 150,000 files lets the
 * event loop breathe, as the indexer does.
 */
async function statAll(
	paths: readonly string[],
	visit: (index: number, stats: Stats | undefined) => void,
): Promise<void> {
	let sliceStart = performance.now()
	for (let i = 0; i < paths.length; i++) {
		let stats: Stats | undefined
		try {
			stats = lstatSync(paths[i] as string)
		} catch {
			stats = undefined
		}
		visit(i, stats)
		if ((i & 63) === 63 && performance.now() - sliceStart > SLICE_MS) {
			await nextTurn()
			sliceStart = performance.now()
		}
	}
}

function named(list: readonly string[]): string {
	return list.length > 3
		? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`
		: list.join(', ')
}

export async function freshenScope(env: Env, scopeRel: string): Promise<Freshened> {
	const { store, root } = env
	const notes: string[] = []
	const gaps: string[] = []

	const fileScope = scopeWhere('path', scopeRel)
	const stored = store.all(
		`SELECT path, size, mtime_ms FROM files${fileScope.sql} LIMIT ?`,
		...fileScope.params,
		MAX_FILES_CHECKED + 1,
	)
	const dirScope = scopeWhere('path', scopeRel)
	const dirRows = store.all(
		`SELECT path, mtime_ms FROM dirs${dirScope.sql} LIMIT ?`,
		...dirScope.params,
		MAX_DIRS_CHECKED + 1,
	)

	const changedFiles: Array<{ rel: string; size: number }> = []
	const checkedFiles = stored.slice(0, MAX_FILES_CHECKED)
	await statAll(
		checkedFiles.map((row) => join(root, ...String(row.path).split('/'))),
		(i, s) => {
			const row = checkedFiles[i] as (typeof checkedFiles)[number]
			if (!s) changedFiles.push({ rel: String(row.path), size: 0 })
			else if (!s.isFile() || s.size !== Number(row.size) || s.mtimeMs !== Number(row.mtime_ms))
				changedFiles.push({ rel: String(row.path), size: s.size })
		},
	)

	const changedDirs: string[] = []
	const checkedDirs = dirRows.slice(0, MAX_DIRS_CHECKED)
	await statAll(
		checkedDirs.map((row) => join(root, ...String(row.path).split('/').filter(Boolean))),
		(i, s) => {
			const row = checkedDirs[i] as (typeof checkedDirs)[number]
			if (!s || s.mtimeMs !== Number(row.mtime_ms)) changedDirs.push(String(row.path))
		},
	)

	// A path that is not recorded at all: a file created since, or a directory.
	if (
		scopeRel !== '' &&
		!stored.some((r) => String(r.path) === scopeRel) &&
		!dirRows.some((r) => String(r.path) === scopeRel)
	) {
		const s = await lstat(join(root, ...scopeRel.split('/'))).catch(() => undefined)
		if (s?.isFile()) {
			// A script with no extension is source when it starts with a node, bun or
			// deno shebang, the same test the walk applies.
			const source =
				languageOf(scopeRel) !== undefined ||
				(isExtensionless(basename(scopeRel)) &&
					(await shebangOf(root, join(root, ...scopeRel.split('/')))))
			if (source) changedFiles.push({ rel: scopeRel, size: s.size })
		} else if (s?.isDirectory()) changedDirs.push(scopeRel)
	}

	if (stored.length > MAX_FILES_CHECKED || dirRows.length > MAX_DIRS_CHECKED) {
		gaps.push(
			`only the first ${checkedFiles.length.toLocaleString('en-US')} files and ${checkedDirs.length.toLocaleString('en-US')} directories were compared with the disk, so later edits may be missing. Run the index operation`,
		)
	}
	if (changedFiles.length === 0 && changedDirs.length === 0) return { notes, gaps }

	const bytes = changedFiles.reduce((a, f) => a + f.size, 0)
	const few =
		changedFiles.length <= FEW_FILES && changedDirs.length <= FEW_DIRS && bytes <= FEW_BYTES
	if (!few) {
		const files = changedFiles.map((f) => f.rel).sort()
		const parts: string[] = []
		if (files.length > 0) {
			parts.push(`${files.length} file(s) changed since indexing (${named(files)})`)
		}
		if (changedDirs.length > 0) {
			parts.push(
				`${changedDirs.length} director${changedDirs.length === 1 ? 'y' : 'ies'} changed since indexing (${named([...changedDirs].sort().map((d) => d || '.'))}), so files added there may be missing`,
			)
		}
		gaps.push(
			`${parts.join('; ')}; too many to re-read for one query. Run the index operation to refresh`,
		)
		return { notes, gaps }
	}

	// Re-read what changed. A changed directory refreshes its own entries only
	// (each subdirectory has a row and a check of its own), and a changed file
	// the directory listing does not already cover is refreshed by itself.
	const dirs = [...new Set(changedDirs)].sort()
	const dirSet = new Set(dirs)
	const parentOf = (rel: string): string =>
		rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
	const lone = changedFiles.map((f) => f.rel).filter((rel) => !dirSet.has(parentOf(rel)))
	let incomplete: string | undefined
	for (const target of [...dirs, ...lone]) {
		const abs = target === '' ? root : join(root, ...target.split('/'))
		// A path outside the root never gets here: every `rel` came from the index
		// or from `toRel` of a resolved scope.
		if (toRel(root, abs) === undefined) continue
		const out = await refreshIndex(
			store,
			root,
			abs,
			{ ...env.options, force: false, quiet: true, shallow: dirSet.has(target) },
			env.host,
			env.signal,
		)
		incomplete ??= out.truncated
	}
	const total = changedFiles.length + changedDirs.length
	notes.push(
		`${changedFiles.length} file(s) and ${changedDirs.length} director${changedDirs.length === 1 ? 'y' : 'ies'} had changed since the index was built and were re-read before this answer`,
	)
	if (incomplete) {
		gaps.push(
			`the re-read of ${total} changed path(s) ${incomplete}, so the answer may miss recent edits. Run the index operation`,
		)
	}
	return { notes, gaps }
}
