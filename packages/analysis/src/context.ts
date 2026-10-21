import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type {
	AnalysisCoverage,
	AnalysisFunction,
	AnalysisFunctionKind,
	AnalysisSourceSlice,
} from '@namzu/sdk'

import { NEVER_SOURCE_DIRS } from './collect.js'
import { conditionOf, readRegular } from './fsafe.js'
import type { ParserHost } from './host.js'
import {
	type IndexOptions,
	coveringEntry,
	decodeText,
	hashOf,
	nextStep,
	noteNamed,
	readCovered,
	refreshIndex,
} from './indexer.js'
import { decodeLineStarts, position } from './lines.js'
import type { Store } from './store.js'

/** What every operation on one root works with. */
export interface Env {
	readonly store: Store
	/** Canonical root. */
	readonly root: string
	readonly host: ParserHost
	readonly options: IndexOptions
	readonly signal?: AbortSignal | undefined
}

/** Re-read ONE file whose bytes changed (or that vanished). */
export async function refreshFile(env: Env, rel: string): Promise<void> {
	await refreshIndex(
		env.store,
		env.root,
		join(env.root, ...rel.split('/')),
		{ ...env.options, force: false },
		env.host,
		env.signal,
	)
}

/** Items per page when a request names none. */
export const DEFAULT_LIMIT = 50
/** The most a page may hold. */
export const MAX_LIMIT = 200
export const DEFAULT_MAX_CHARS = 20_000
export const MIN_MAX_CHARS = 200
export const MAX_MAX_CHARS = 200_000
/** How much of a literal a hit prints. */
export const PREVIEW_CHARS = 200

type Row = Record<string, unknown>

export function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
	return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

export function clampChars(max: number | undefined): number {
	if (max === undefined || !Number.isFinite(max)) return DEFAULT_MAX_CHARS
	return Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, Math.floor(max)))
}

// ─── cursors ────────────────────────────────────────────────────────────────

interface CursorBody {
	/** The index generation the page was cut from. */
	readonly g: number
	/** Offset of the next item. */
	readonly o: number
	/** Fingerprint of the request, so a cursor cannot be replayed on another query. */
	readonly q: string
}

export function fingerprint(parts: readonly unknown[]): string {
	return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 10)
}

export function encodeCursor(body: CursorBody): string {
	return Buffer.from(JSON.stringify(body)).toString('base64url')
}

/** A page offset, or the reason the cursor cannot be used. */
export function decodeCursor(
	cursor: string | undefined,
	generation: number,
	q: string,
): { offset: number } | { error: string } {
	if (cursor === undefined || cursor === '') return { offset: 0 }
	let body: CursorBody
	try {
		body = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorBody
		if (
			!Number.isInteger(body.o) ||
			body.o < 0 ||
			!Number.isInteger(body.g) ||
			typeof body.q !== 'string'
		) {
			throw new Error('shape')
		}
	} catch {
		return { error: 'The cursor is not one this index issued. Repeat the query without it.' }
	}
	if (body.q !== q) {
		return { error: 'The cursor belongs to a different query. Repeat the query without it.' }
	}
	if (body.g !== generation) {
		return {
			error:
				'The index changed since that page was produced, so its position no longer means anything. Repeat the query without a cursor.',
		}
	}
	return { offset: body.o }
}

// ─── files ──────────────────────────────────────────────────────────────────

export interface FileInfo {
	readonly id: number
	/** Relative, POSIX-separated. */
	readonly rel: string
	readonly abs: string
	readonly chars: number
	readonly parseErrors: number
	readonly degraded: number
	readonly size: number
	readonly mtimeMs: number
	readonly hash: string
	readonly starts: Uint32Array
}

/**
 * A row this query read points at one that is gone: another process replaced
 * the file's rows while the query was between its reads. Not a failure of the
 * index; the query is simply run again against the new rows.
 */
export class StaleIndexError extends Error {
	override readonly name = 'StaleIndexError'
}

/** Per-request cache of file rows, so a page of hits decodes each line table once. */
export class Files {
	private readonly byId = new Map<number, FileInfo>()
	constructor(
		private readonly store: Store,
		readonly root: string,
	) {}

	private from(row: Row): FileInfo {
		const rel = String(row.path)
		return {
			id: Number(row.id),
			rel,
			abs: join(this.root, ...rel.split('/')),
			chars: Number(row.chars),
			parseErrors: Number(row.parse_errors),
			degraded: Number(row.degraded ?? 0),
			size: Number(row.size),
			mtimeMs: Number(row.mtime_ms),
			hash: String(row.hash),
			starts: decodeLineStarts(row.line_starts as Uint8Array),
		}
	}

	byIdOrThrow(id: number): FileInfo {
		let info = this.byId.get(id)
		if (!info) {
			const row = this.store.get('SELECT * FROM files WHERE id = ?', id)
			// Another process re-indexed the file between this query's reads.
			if (!row) throw new StaleIndexError(`file ${id} is not in the index`)
			info = this.from(row)
			this.byId.set(id, info)
		}
		return info
	}

	byPath(rel: string): FileInfo | undefined {
		const row = this.store.get('SELECT * FROM files WHERE path = ?', rel)
		if (!row) return undefined
		const info = this.from(row)
		this.byId.set(info.id, info)
		return info
	}

	forget(id: number): void {
		this.byId.delete(id)
	}
}

/** What a page of results found out about the files behind it. */
export interface Freshness {
	/** Files that changed or vanished, by file id, for marking hits. */
	readonly marks: Map<number, 'changed' | 'deleted'>
	/** Files dropped from the index because they became links or left the root. */
	readonly dropped: string[]
}

/**
 * Compare the files behind a page of results with the disk, by `lstat` and a
 * canonical-path check — one pair of calls per distinct file, no reads.
 *
 * A file that is no longer a regular file inside the root is DROPPED from the
 * index (rows and all) and named in coverage, and the caller re-runs its
 * query: a hit from such a file must never be shown, cited as an in-root path.
 * A file that merely changed or was deleted keeps its rows and its hits are
 * marked, because the rows are still true of the file as it was.
 */
export async function checkFreshness(
	store: Store,
	files: Files,
	root: string,
	candidates: Iterable<number>,
): Promise<Freshness> {
	const marks = new Map<number, 'changed' | 'deleted'>()
	const dropped: string[] = []
	for (const id of new Set(candidates)) {
		const info = files.byIdOrThrow(id)
		const condition = await conditionOf(root, info.abs, info)
		if (condition === 'changed' || condition === 'deleted') marks.set(id, condition)
		else if (condition === 'violation') dropped.push(info.rel)
	}
	if (dropped.length > 0) await dropFiles(store, files, dropped)
	return { marks, dropped }
}

/** Remove files from the index and name them, under the write lock. */
export async function dropFiles(
	store: Store,
	files: Files,
	rels: readonly string[],
): Promise<void> {
	await store.begin()
	try {
		for (const rel of rels) {
			const info = files.byPath(rel)
			if (info) {
				store.removeFile(info.id)
				files.forget(info.id)
			}
			noteNamed(store, 'violations', rel)
		}
		store.bumpGeneration()
		store.commit()
	} catch (err) {
		store.rollback()
		throw err
	}
}

export function markReasons(marks: ReadonlyMap<number, 'changed' | 'deleted'>): string[] {
	const reasons: string[] = []
	const changed = [...marks.values()].filter((m) => m === 'changed').length
	const deleted = marks.size - changed
	if (changed > 0) {
		reasons.push(
			`${changed} file(s) changed on disk since they were indexed; positions from them may be off. Run the index operation to refresh`,
		)
	}
	if (deleted > 0) {
		reasons.push(`${deleted} file(s) behind these results were deleted since they were indexed`)
	}
	return reasons
}

export interface Verified {
	readonly info: FileInfo
	readonly text: string
	/** The file was re-read because it had changed since it was indexed. */
	readonly refreshed: boolean
}

/**
 * The file's text, guaranteed to be the text its rows were built from, and to
 * have come from a regular file inside the root.
 *
 * A slice cut from different text than was parsed is wrong in a way that still
 * looks right: the offsets land mid-token and the citation is plausible. So the
 * content hash is compared on every read, and a file that changed is
 * re-indexed before anything is answered from it. The read itself is
 * `readRegular`: a file replaced by a link is dropped from the index and
 * refused, never read through.
 */
export async function readVerified(
	env: Env,
	files: Files,
	info: FileInfo,
	options: { refresh: boolean },
): Promise<Verified | { error: string }> {
	const { store, root } = env
	const read = await readRegular(root, info.abs)
	if (!read.ok) {
		if (read.why === 'link' || read.why === 'outside' || read.why === 'not-file') {
			await dropFiles(store, files, [info.rel])
			return {
				error: `${info.rel} is no longer a regular file inside the indexed root (it is a link or resolves elsewhere), so it was dropped from the index and nothing was read from it.`,
			}
		}
		await refreshFile(env, info.rel)
		files.forget(info.id)
		return { error: `${info.rel} no longer exists, so nothing can be read from it.` }
	}
	if (hashOf(read.buffer) === info.hash) {
		const text = decodeText(read.buffer)
		if (text === undefined) return { error: `${info.rel} is no longer readable as text.` }
		return { info, text, refreshed: false }
	}
	await refreshFile(env, info.rel)
	files.forget(info.id)
	if (!options.refresh) {
		return {
			error: `${info.rel} changed since it was indexed, and function ids are re-issued when a file is re-read. The index has been refreshed; look the function up again.`,
		}
	}
	const next = files.byPath(info.rel)
	if (!next) return { error: `${info.rel} changed and can no longer be indexed.` }
	const again = await readRegular(root, next.abs)
	if (!again.ok) return { error: `${info.rel} changed while it was being read.` }
	const text = decodeText(again.buffer)
	if (text === undefined) return { error: `${info.rel} is not readable as text.` }
	return { info: next, text, refreshed: true }
}

// ─── functions ──────────────────────────────────────────────────────────────

export function toFunction(row: Row, info: FileInfo): AnalysisFunction {
	const start = Number(row.start)
	const at = position(info.starts, start)
	return {
		id: Number(row.id),
		name: row.name === null || row.name === undefined ? null : String(row.name),
		...(row.qname !== null && row.qname !== undefined ? { qualifiedName: String(row.qname) } : {}),
		kind: String(row.kind) as AnalysisFunctionKind,
		path: info.abs,
		line: at.line,
		column: at.column,
		endLine: Number(row.eline),
		start,
		end: Number(row.end),
	}
}

/** Parents of a function, innermost first. Bounded: a cycle must not hang a query. */
export function parentsOf(store: Store, files: Files, parentId: number | null): AnalysisFunction[] {
	const out: AnalysisFunction[] = []
	let next = parentId
	while (next !== null && out.length < 64) {
		const row = store.get('SELECT * FROM functions WHERE id = ?', next)
		if (!row) break
		out.push(toFunction(row, files.byIdOrThrow(Number(row.file_id))))
		next = row.parent_id === null ? null : Number(row.parent_id)
	}
	return out
}

/** A character offset that does not land between the halves of a surrogate pair, moved earlier if it does. */
function safeEnd(text: string, at: number): number {
	const last = text.charCodeAt(at - 1)
	return last >= 0xd800 && last <= 0xdbff ? at - 1 : at
}

/** The header of a windowed slice: its first quarter of the budget, at most this. */
const HEADER_CHARS = 400

/**
 * `text[start, end)`, cut to `maxChars`.
 *
 * Without `around` the cut is at the end. With it (the offset a question was
 * asked about) the slice is the function's header, then the characters around
 * `around`, and the position is inside what is returned: the 2.3 % of literals
 * in a large bundle that sit past the first 20,000 characters of their function
 * are exactly the ones a head cut loses.
 */
export function sliceOf(
	text: string,
	start: number,
	end: number,
	maxChars: number,
	around?: number,
): AnalysisSourceSlice {
	const chars = end - start
	if (chars <= maxChars) return { text: text.slice(start, end), chars, truncated: false }
	if (around === undefined || around < start || around >= end) {
		return { text: text.slice(start, safeEnd(text, start + maxChars)), chars, truncated: true }
	}
	const header = Math.min(Math.floor(maxChars / 4), HEADER_CHARS)
	const headerEnd = safeEnd(text, start + header)
	const budget = maxChars - header
	let from = around - Math.floor(budget / 2)
	let to = from + budget
	if (from < headerEnd) {
		from = headerEnd
		to = from + budget
	}
	if (to > end) {
		to = end
		from = Math.max(headerEnd, to - budget)
	}
	// Whole characters at both ends.
	const first = text.charCodeAt(from)
	if (from > headerEnd && first >= 0xdc00 && first <= 0xdfff) from--
	to = safeEnd(text, to)
	const gapBefore = from - headerEnd
	const gapAfter = end - to
	const cut =
		text.slice(start, headerEnd) +
		(gapBefore > 0 ? `\n/* … ${gapBefore.toLocaleString('en-US')} characters omitted … */\n` : '') +
		text.slice(from, to) +
		(gapAfter > 0 ? `\n/* … ${gapAfter.toLocaleString('en-US')} characters omitted … */` : '')
	return {
		text: cut,
		chars,
		truncated: true,
		window: { headerChars: headerEnd - start, from, to },
	}
}

// ─── coverage ───────────────────────────────────────────────────────────────

/** Skip reasons that are choices, not gaps: nothing was lost by them. */
const BENIGN_SKIPS = new Set(['declaration file', 'symbolic link'])

function listOf(store: Store, key: string): string[] {
	try {
		const v = JSON.parse(store.meta(key) ?? '[]')
		return Array.isArray(v) ? (v as string[]) : []
	} catch {
		return []
	}
}

function named(list: readonly string[]): string {
	return list.length > 3
		? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`
		: list.join(', ')
}

/**
 * What the index is missing for a question about `scopeRel` (empty: the whole
 * root), in words, each with what to do about it.
 *
 * Nothing here is a refusal. A partial index answers; these are the reasons
 * the answer may not be the whole answer, and the next step that makes it
 * more of one.
 */
export function workspaceGaps(store: Store, scopeRel = ''): string[] {
	const reasons: string[] = []
	const covered = readCovered(store)
	const covering = coveringEntry(covered, scopeRel)
	if (scopeRel === '') {
		if (!covering) {
			const parts = covered.map((e) => (e.s === '' ? 'the root' : e.s))
			reasons.push(
				`only part of the root is indexed (${named(parts)}); call the index operation with a path to cover another part`,
			)
		}
	}
	for (const e of covered) {
		if (e.c === 0 && (scopeRel === '' || e === covering)) {
			const where = e.s === '' ? 'the root' : e.s
			reasons.push(
				e.k === 'cancel'
					? `indexing ${where} ${e.r}, so what was indexed is partial. Call the index operation to continue`
					: `indexing ${where} ${e.r ?? 'stopped at a limit'}, so what was indexed is partial. ${nextStep(e.w)}`,
			)
		}
	}
	let skipped: Record<string, Record<string, number>> = {}
	try {
		skipped = JSON.parse(store.meta('skipped') ?? '{}') as typeof skipped
	} catch {
		skipped = {}
	}
	const totals = new Map<string, number>()
	for (const [scope, reasonsFor] of Object.entries(skipped)) {
		if (scopeRel !== '' && scope !== '' && scope !== scopeRel && !scopeRel.startsWith(`${scope}/`))
			continue
		for (const [why, n] of Object.entries(reasonsFor)) {
			if (!BENIGN_SKIPS.has(why)) totals.set(why, (totals.get(why) ?? 0) + n)
		}
	}
	if (totals.size > 0) {
		reasons.push(`not indexed: ${[...totals].map(([why, n]) => `${n} ${why}`).join(', ')}`)
	}
	reasons.push(...exclusionReasons(store, scopeRel))
	const crashed = listOf(store, 'crashed')
	if (crashed.length > 0) {
		reasons.push(
			`the parser crashed on ${crashed.length} file(s) (${named(crashed)}), which are recorded with no rows`,
		)
	}
	const violations = listOf(store, 'violations')
	if (violations.length > 0) {
		reasons.push(
			`${violations.length} file(s) (${named(violations)}) became a link or resolved outside the root after they were indexed, and were dropped without being read`,
		)
	}
	const bad = store.get(
		'SELECT count(*) AS n, coalesce(sum(degraded = 1), 0) AS repaired, coalesce(sum(degraded = 2), 0) AS scanned FROM files WHERE parse_errors > 0',
	)
	if (bad && Number(bad.n) > 0) {
		const repaired = Number(bad.repaired)
		const scanned = Number(bad.scanned)
		reasons.push(
			`${bad.n} file(s) had syntax errors, so rows from them may be missing${repaired > 0 ? `; ${repaired} read after setting the broken lines aside` : ''}${scanned > 0 ? `; ${scanned} degraded to a tolerant scan that finds strings and function declarations only, with no calls, methods or imports` : ''}`,
		)
	}
	return reasons
}

/** `dist ×17, build ×2` — the most common first, the rest counted. */
function tally(rows: ReadonlyArray<{ name: string; n: number }>, shown = 6): string {
	const sorted = [...rows].sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1))
	const head = sorted.slice(0, shown).map((r) => `${r.name || '(none)'} ×${r.n}`)
	return sorted.length > shown
		? `${head.join(', ')} and ${sorted.length - shown} more`
		: head.join(', ')
}

/**
 * What the walk saw under `scopeRel` and did not index, as reasons.
 *
 * "Complete" has to mean nothing relevant was excluded, and the index excludes
 * four things by design: directories on the ignore list, paths a `.gitignore`
 * lists, files in languages it does not parse, and declaration files. Each is
 * named with a count, because a search that found nothing in the part that was
 * indexed says nothing about the part that was not. Vendored and tool-owned
 * directories (`node_modules`, `.git`, …) are not listed: nobody asks about
 * them by accident, and asking by path indexes them.
 */
export function exclusionReasons(store: Store, scopeRel: string): string[] {
	const where =
		scopeRel === ''
			? { sql: '', params: [] as string[] }
			: {
					sql: ' WHERE path = ? OR (path >= ? AND path < ?)',
					params: [scopeRel, `${scopeRel}/`, `${scopeRel}0`],
				}
	let rows: Record<string, unknown>[]
	try {
		rows = store.all(
			`SELECT kind, name, sum(n) AS n FROM excl${where.sql} GROUP BY kind, name`,
			...where.params,
		)
	} catch {
		return []
	}
	const pick = (kind: string, keep: (name: string) => boolean = () => true) =>
		rows
			.filter((r) => r.kind === kind && keep(String(r.name)))
			.map((r) => ({ name: String(r.name), n: Number(r.n) }))
	const dirs = pick('dir', (name) => !NEVER_SOURCE_DIRS.has(name))
	const git = pick('git')
	const exts = pick('ext')
	const dts = pick('dts').reduce((a, r) => a + r.n, 0)
	const reasons: string[] = []
	if (dirs.length > 0) {
		reasons.push(
			`not indexed: ignored directories ${tally(dirs)}. To search one, pass its path to the index operation`,
		)
	}
	if (git.length > 0) {
		reasons.push(
			`not indexed: paths a .gitignore lists, ${tally(git)}. Index one by path to search it`,
		)
	}
	if (exts.length > 0) {
		reasons.push(
			`not indexed: files in languages this index does not parse (${tally(exts)}); a string in one cannot be found`,
		)
	}
	if (dts > 0) {
		reasons.push(
			`${dts} declaration file(s) (.d.ts) are not indexed; they hold types only, so no literal or call is missing, but a signature there cannot be shown`,
		)
	}
	return reasons
}

export function coverageOf(reasons: readonly string[]): AnalysisCoverage {
	return reasons.length === 0 ? { status: 'complete' } : { status: 'partial', reasons }
}

/** Escape `%`, `_` and the escape character itself for a LIKE pattern. */
export function likeEscape(text: string): string {
	return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}
