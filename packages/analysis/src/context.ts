import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type {
	AnalysisCoverage,
	AnalysisFunction,
	AnalysisFunctionKind,
	AnalysisSourceSlice,
} from '@namzu/sdk'

import { decodeText, hashOf, refreshFile } from './indexer.js'
import { decodeLineStarts, position } from './lines.js'
import type { Store } from './store.js'

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

/** The key a cache file is named by: the canonical root, hashed. */
export function cacheKey(root: string): string {
	return createHash('sha256').update(root).digest('hex').slice(0, 16)
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
	readonly size: number
	readonly mtimeMs: number
	readonly hash: string
	readonly starts: Uint32Array
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
			if (!row) throw new Error(`file ${id} is not in the index`)
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

/**
 * Files, out of `candidates`, that differ on disk from what was indexed.
 *
 * By size and mtime only, which is what a page of results can afford: one
 * `stat` per distinct file. A rewrite that keeps both is missed here and
 * caught by the content hash wherever a source slice is cut.
 */
export async function staleFiles(files: Files, candidates: Iterable<number>): Promise<string[]> {
	const stale: string[] = []
	for (const id of new Set(candidates)) {
		const info = files.byIdOrThrow(id)
		try {
			const s = await stat(info.abs)
			if (s.size !== info.size || s.mtimeMs !== info.mtimeMs) stale.push(info.rel)
		} catch {
			stale.push(info.rel)
		}
	}
	return stale
}

export interface Verified {
	readonly info: FileInfo
	readonly text: string
	/** The file was re-read because it had changed since it was indexed. */
	readonly refreshed: boolean
}

/**
 * The file's text, guaranteed to be the text its rows were built from.
 *
 * A slice cut from different text than was parsed is wrong in a way that
 * still looks right: the offsets land mid-token and the citation is
 * plausible. So the content hash is compared on every read, and a file that
 * changed is re-indexed before anything is answered from it.
 */
export async function readVerified(
	store: Store,
	files: Files,
	root: string,
	info: FileInfo,
	options: { refresh: boolean },
): Promise<Verified | { error: string }> {
	let buffer: Uint8Array
	try {
		buffer = await readFile(info.abs)
	} catch {
		await refreshFile(store, root, info.rel)
		files.forget(info.id)
		return { error: `${info.rel} no longer exists, so nothing can be read from it.` }
	}
	if (hashOf(buffer) === info.hash) {
		const text = decodeText(buffer)
		if (text === undefined) return { error: `${info.rel} is no longer readable as text.` }
		return { info, text, refreshed: false }
	}
	if (!options.refresh) {
		await refreshFile(store, root, info.rel)
		files.forget(info.id)
		return {
			error: `${info.rel} changed since it was indexed, and function ids are re-issued when a file is re-read. The index has been refreshed; look the function up again.`,
		}
	}
	const outcome = await refreshFile(store, root, info.rel)
	files.forget(info.id)
	if (outcome === 'removed' || outcome === 'unreadable') {
		return { error: `${info.rel} changed and can no longer be indexed (${outcome}).` }
	}
	const next = files.byPath(info.rel)
	if (!next) return { error: `${info.rel} is not in the index after re-reading it.` }
	const text = decodeText(await readFile(next.abs))
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

export function sliceOf(
	text: string,
	start: number,
	end: number,
	maxChars: number,
): AnalysisSourceSlice {
	const chars = end - start
	if (chars <= maxChars) return { text: text.slice(start, end), chars, truncated: false }
	let stop = start + maxChars
	const last = text.charCodeAt(stop - 1)
	// Do not hand back half of a surrogate pair.
	if (last >= 0xd800 && last <= 0xdbff) stop--
	return { text: text.slice(start, stop), chars, truncated: true }
}

// ─── coverage ───────────────────────────────────────────────────────────────

/** Skip reasons that are choices, not gaps: nothing was lost by them. */
const BENIGN_SKIPS = new Set(['declaration file', 'symbolic link'])

/** What the index as a whole is missing, in words. */
export function workspaceGaps(store: Store): string[] {
	const reasons: string[] = []
	let skipped: Record<string, number> = {}
	try {
		skipped = JSON.parse(store.meta('skipped') ?? '{}') as Record<string, number>
	} catch {
		skipped = {}
	}
	const gaps = Object.entries(skipped).filter(([why]) => !BENIGN_SKIPS.has(why))
	if (gaps.length > 0) {
		reasons.push(`not indexed: ${gaps.map(([why, n]) => `${n} ${why}`).join(', ')}`)
	}
	const bad = store.get('SELECT count(*) AS n FROM files WHERE parse_errors > 0')
	if (bad && Number(bad.n) > 0) {
		reasons.push(
			`${bad.n} file(s) had syntax errors; the parser kept whatever tree it could recover, often none, so rows from them may be missing`,
		)
	}
	return reasons
}

export function coverageOf(reasons: readonly string[]): AnalysisCoverage {
	return reasons.length === 0 ? { status: 'complete' } : { status: 'partial', reasons }
}

export function staleReason(stale: readonly string[]): string[] {
	if (stale.length === 0) return []
	const shown = stale.slice(0, 3).join(', ')
	const more = stale.length > 3 ? ` and ${stale.length - 3} more` : ''
	return [
		`${stale.length} file(s) changed on disk since they were indexed (${shown}${more}); positions from them may be off. Run the index operation to refresh`,
	]
}

/** Escape `%`, `_` and the escape character itself for a LIKE pattern. */
export function likeEscape(text: string): string {
	return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}
