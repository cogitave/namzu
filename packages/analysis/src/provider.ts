import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type {
	AnalysisCallSite,
	AnalysisEnclosingFunction,
	AnalysisEvidence,
	AnalysisFunctionSource,
	AnalysisLiteralHit,
	AnalysisModuleEdge,
	AnalysisPage,
	CallersOfRequest,
	CodeAnalysisProvider,
	CodeAnalysisResult,
	EnclosingFunctionRequest,
	FindLiteralRequest,
	FunctionSourceRequest,
	ImportsRequest,
	IndexRequest,
	IndexSummary,
} from '@namzu/sdk'

import {
	type FileInfo,
	Files,
	PREVIEW_CHARS,
	cacheKey,
	clampChars,
	clampLimit,
	coverageOf,
	decodeCursor,
	encodeCursor,
	fingerprint,
	likeEscape,
	parentsOf,
	readVerified,
	sliceOf,
	staleFiles,
	staleReason,
	toFunction,
	workspaceGaps,
} from './context.js'
import {
	DEFAULT_IGNORED_DIRS,
	DEFAULT_MAX_FILES,
	DEFAULT_MAX_FILE_BYTES,
	type IndexOptions,
	refreshIndex,
	toRel,
} from './indexer.js'
import { offsetOf, position } from './lines.js'
import { ParserUnavailableError } from './parse.js'
import { Store } from './store.js'

export interface CodeAnalysisOptions {
	/**
	 * Directory the per-root index files live in, owned by the host.
	 *
	 * Absent keeps every index in memory: queries work, nothing is written, and
	 * each process starts cold. An unwritable directory falls back the same way
	 * and the summary says `persisted: false`.
	 */
	readonly cacheDir?: string
	/** Directory names never entered. Replaces the default list. */
	readonly ignoreDirs?: readonly string[]
	/** Files larger than this are skipped and counted. Default 32 MiB. */
	readonly maxFileBytes?: number
	/** Stop collecting past this many files, and say so. Default 150,000. */
	readonly maxFiles?: number
	/**
	 * `auto` (default) builds a trigram FTS5 index of literals when this Node
	 * has FTS5 (22.16 and newer). `off` never does, and `find_literal` scans.
	 * Turning it off for a cache that was built with it rebuilds the cache.
	 */
	readonly substringIndex?: 'auto' | 'off'
}

type Row = Record<string, unknown>
type Result<T> = CodeAnalysisResult<T>

const failed = <T>(error: string): Result<T> => ({ kind: 'failed', error })

/** An exception inside a query, as the answer it is: unsupported for a missing parser, else failed. */
function explain<T>(err: unknown): Result<T> {
	if (err instanceof ParserUnavailableError) return { kind: 'unsupported', reason: err.message }
	return failed(err instanceof Error ? err.message : String(err))
}

/** One root's open store, shared by every request for it. */
interface Opened {
	readonly store: Store
	readonly root: string
}

/**
 * The provider: a directory of JavaScript and TypeScript in, cited answers out.
 *
 * One SQLite database per root, keyed by the root's real path, in `cacheDir`.
 * Requests for one root queue behind each other (SQLite is one connection
 * here, and an index run yields to the event loop mid-transaction), requests
 * for different roots do not.
 *
 * Nothing heavy is loaded until the first call: `oxc-parser` on the first
 * parse, `node:sqlite` on the first store.
 */
export function createCodeAnalysisProvider(
	options: CodeAnalysisOptions = {},
): CodeAnalysisProvider {
	const opened = new Map<string, Promise<Opened | { error: string }>>()
	const indexOptions = (force: boolean): IndexOptions => ({
		ignoreDirs: options.ignoreDirs ?? DEFAULT_IGNORED_DIRS,
		maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
		maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
		force,
	})

	async function open(rootInput: string): Promise<Opened | { error: string }> {
		let root: string
		try {
			root = await realpath(rootInput)
			if (!(await stat(root)).isDirectory()) return { error: `${rootInput} is not a directory.` }
		} catch {
			return { error: `${rootInput} does not exist.` }
		}
		let pending = opened.get(root)
		if (!pending) {
			pending = (async () => {
				const location =
					options.cacheDir !== undefined
						? join(options.cacheDir, `${cacheKey(root)}.sqlite`)
						: undefined
				const store = await Store.open(root, location, options.substringIndex !== 'off')
				if (!store) {
					return {
						error:
							'node:sqlite is not available in this Node.js, so there is nowhere to keep an index. It needs Node 22.5 or newer.',
					}
				}
				return { store, root }
			})()
			opened.set(root, pending)
			// A failed open must not poison the root for the process's lifetime.
			void pending.then((r) => {
				if ('error' in r) opened.delete(root)
			})
		}
		return await pending
	}

	/**
	 * Run `body` against a root's store, building the index first if this root
	 * has never been indexed. The returned note says so, because the first call
	 * taking seconds is something the reader should be told, not left to infer.
	 */
	async function withIndex<T>(
		rootInput: string,
		body: (o: Opened, built: string | undefined) => Promise<Result<T>>,
	): Promise<Result<T>> {
		const o = await open(rootInput)
		if ('error' in o) return { kind: 'unsupported', reason: o.error }
		try {
			return await o.store.run(async () => {
				let built: string | undefined
				if (o.store.meta('built') !== '1') {
					const started = performance.now()
					const outcome = await refreshIndex(o.store, o.root, indexOptions(false))
					built = `the index for ${o.root} did not exist and was built for this call: ${outcome.indexed} files in ${Math.round(performance.now() - started)} ms`
				}
				return await body(o, built)
			})
		} catch (err) {
			return explain(err)
		}
	}

	const evidence = (
		observed: readonly string[],
		inferred: readonly string[],
		gaps: readonly string[],
		built?: string,
	): AnalysisEvidence => ({
		observed: built ? [...observed, built] : observed,
		inferred,
		coverage: coverageOf(gaps),
	})

	/** The indexed file at `abs`, or the reason there is none. */
	function fileAt(o: Opened, files: Files, abs: string): FileInfo | { error: string } {
		const rel = toRel(o.root, abs)
		if (rel === undefined || rel === '') {
			return { error: `${abs} is not a file under the indexed root ${o.root}.` }
		}
		const info = files.byPath(rel)
		if (info) return info
		return {
			error: `${rel} is not in the index. Only .js .mjs .cjs .jsx .ts .mts .cts .tsx files are indexed, and not declaration files, symbolic links, files in ignored directories (${(options.ignoreDirs ?? DEFAULT_IGNORED_DIRS).join(', ')}), or files that are binary, too large or unparseable.`,
		}
	}

	function scopeSql(
		o: Opened,
		files: Files,
		path: string | undefined,
		column: string,
	): { sql: string; params: unknown[] } | { error: string } {
		if (path === undefined) return { sql: '', params: [] }
		const rel = toRel(o.root, path)
		if (rel === undefined) return { error: `${path} is outside the indexed root ${o.root}.` }
		if (rel === '') return { sql: '', params: [] }
		const file = files.byPath(rel)
		if (file) return { sql: ` AND ${column} = ?`, params: [file.id] }
		return {
			sql: ` AND ${column} IN (SELECT id FROM files WHERE path >= ? AND path < ?)`,
			params: [`${rel}/`, `${rel}0`],
		}
	}

	const provider: CodeAnalysisProvider = {
		async index(request: IndexRequest): Promise<Result<IndexSummary>> {
			const o = await open(request.root)
			if ('error' in o) return { kind: 'unsupported', reason: o.error }
			try {
				return await o.store.run(async () => {
					const started = performance.now()
					const out = await refreshIndex(o.store, o.root, indexOptions(request.force === true))
					const count = (table: string): number =>
						Number((o.store.get(`SELECT count(*) AS n FROM ${table}`) as Row).n)
					const gaps = workspaceGaps(o.store)
					const summary: IndexSummary = {
						root: o.root,
						persisted: o.store.persisted,
						files: {
							indexed: out.indexed,
							parsed: out.parsed,
							unchanged: out.unchanged,
							removed: out.removed,
							skipped: out.skipped,
							withParseErrors: out.withParseErrors,
						},
						skippedReasons: out.skippedReasons,
						functions: count('functions'),
						strings: count('strings'),
						calls: count('calls'),
						durationMs: Math.round(performance.now() - started),
					}
					return {
						kind: 'ok',
						value: summary,
						evidence: evidence(
							[
								`walked ${o.root}: ${out.parsed} file(s) parsed, ${out.unchanged} unchanged by size, mtime or content hash, ${out.removed} removed`,
							],
							o.store.fts
								? []
								: [
										'this Node.js has no FTS5, so find_literal scans every literal instead of using a substring index; answers are the same, slower',
									],
							gaps,
						),
					}
				})
			} catch (err) {
				return explain(err)
			}
		},

		findLiteral: (request: FindLiteralRequest) =>
			withIndex(request.root, async (o, built) => {
				const files = new Files(o.store, o.root)
				const scope = scopeSql(o, files, request.path, 's.file_id')
				if ('error' in scope) return failed(scope.error)
				const limit = clampLimit(request.limit)
				const generation = Number(o.store.meta('generation') ?? '0')
				const q = fingerprint([
					'find',
					request.text,
					request.path ?? null,
					request.caseSensitive === false,
				])
				const cursor = decodeCursor(request.cursor, generation, q)
				if ('error' in cursor) return failed(cursor.error)

				const insensitive = request.caseSensitive === false
				const test = insensitive ? 'instr(lower(s.value), lower(?)) > 0' : 'instr(s.value, ?) > 0'
				const useFts = o.store.fts && request.text.length >= 3
				const prefilter = useFts ? ' AND s.id IN (SELECT rowid FROM lit WHERE lit MATCH ?)' : ''
				const where = `WHERE ${test}${prefilter}${scope.sql}`
				const params: unknown[] = [
					request.text,
					...(useFts ? [`"${request.text.replaceAll('"', '""')}"`] : []),
					...scope.params,
				]
				const total = Number(
					(o.store.get(`SELECT count(*) AS n FROM strings s ${where}`, ...params) as Row).n,
				)
				const rows = o.store.all(
					`SELECT s.id, s.file_id, s.fn_id, s.start, s."end", s.kind, s.value FROM strings s ${where} ORDER BY s.id LIMIT ? OFFSET ?`,
					...params,
					limit,
					cursor.offset,
				)
				const fnCache = new Map<number, ReturnType<typeof toFunction>>()
				const items: AnalysisLiteralHit[] = rows.map((r) => {
					const info = files.byIdOrThrow(Number(r.file_id))
					const at = position(info.starts, Number(r.start))
					const value = String(r.value)
					let fn: ReturnType<typeof toFunction> | undefined
					if (r.fn_id !== null && r.fn_id !== undefined) {
						const id = Number(r.fn_id)
						fn = fnCache.get(id)
						if (!fn) {
							const fr = o.store.get('SELECT * FROM functions WHERE id = ?', id)
							if (fr) {
								fn = toFunction(fr, info)
								fnCache.set(id, fn)
							}
						}
					}
					return {
						path: info.abs,
						line: at.line,
						column: at.column,
						start: Number(r.start),
						end: Number(r.end),
						kind: String(r.kind) as AnalysisLiteralHit['kind'],
						value: value.length > PREVIEW_CHARS ? value.slice(0, PREVIEW_CHARS) : value,
						valueTruncated: value.length > PREVIEW_CHARS,
						...(fn ? { function: fn } : {}),
					}
				})
				const stale = await staleFiles(
					files,
					rows.map((r) => Number(r.file_id)),
				)
				const next = cursor.offset + items.length
				const page: AnalysisPage<AnalysisLiteralHit> = {
					items,
					total,
					...(next < total ? { nextCursor: encodeCursor({ g: generation, o: next, q }) } : {}),
				}
				return {
					kind: 'ok',
					value: page,
					evidence: evidence(
						[
							`${total} string or template literal(s) contain ${JSON.stringify(request.text)}${insensitive ? ' (ASCII case-insensitive)' : ''}`,
							'each hit lists the innermost function whose source range contains it',
						],
						[
							'literals are indexed up to 4096 characters, and a template literal is indexed per static chunk, so a match cannot span a ${...} or sit past the cut',
						],
						[...workspaceGaps(o.store), ...staleReason(stale)],
						built,
					),
				}
			}),

		enclosingFunction: (request: EnclosingFunctionRequest) =>
			withIndex(request.root, async (o, built) => {
				const files = new Files(o.store, o.root)
				const found = fileAt(o, files, request.path)
				if ('error' in found) return failed(found.error)
				const verified = await readVerified(o.store, files, o.root, found, { refresh: true })
				if ('error' in verified) return failed(verified.error)
				const { info, text } = verified
				const at = offsetOf(info.starts, info.chars, request.line, request.column ?? 1)
				if ('error' in at) return failed(`${info.rel}: ${at.error}`)

				const row = o.store.get(
					'SELECT * FROM functions WHERE file_id = ? AND start <= ? AND "end" > ? ORDER BY start DESC, "end" ASC, id DESC LIMIT 1',
					info.id,
					at.offset,
					at.offset,
				)
				const gaps = info.parseErrors > 0 ? [parseGap(info)] : []
				const notes = [
					...(verified.refreshed
						? [`${info.rel} had changed since it was indexed and was re-read`]
						: []),
					...(built ? [built] : []),
				]
				if (!row) {
					return {
						kind: 'ok',
						value: { function: null, parents: [] } satisfies AnalysisEnclosingFunction,
						evidence: {
							observed: [
								`${info.rel}:${request.line}:${request.column ?? 1} lies in no function body; it is at the top level of the file`,
								...notes,
							],
							inferred: [],
							coverage: coverageOf(gaps),
						},
					}
				}
				const fn = toFunction(row, info)
				const parents = parentsOf(
					o.store,
					files,
					row.parent_id === null ? null : Number(row.parent_id),
				)
				return {
					kind: 'ok',
					value: {
						function: fn,
						parents,
						source: sliceOf(text, fn.start, fn.end, clampChars(request.maxChars)),
					} satisfies AnalysisEnclosingFunction,
					evidence: {
						observed: [
							`offset ${at.offset} lies in [${fn.start}, ${fn.end}) of ${info.rel}, the innermost function range that contains it`,
							'the source is the exact slice of the file, verified against its content hash',
							...notes,
						],
						inferred:
							fn.name === null
								? [
										'the function has no name of its own and none could be inferred from its context',
									]
								: [],
						coverage: coverageOf(gaps),
					},
				}
			}),

		functionSource: (request: FunctionSourceRequest) =>
			withIndex(request.root, async (o, built) => {
				const files = new Files(o.store, o.root)
				const maxChars = clampChars(request.maxChars)
				const limit = clampLimit(request.limit)
				const generation = Number(o.store.meta('generation') ?? '0')
				const q = fingerprint([
					'source',
					request.id ?? null,
					request.path ?? null,
					request.name ?? null,
					maxChars,
				])
				const cursor = decodeCursor(request.cursor, generation, q)
				if ('error' in cursor) return failed(cursor.error)

				let rows: Row[]
				let total: number
				let info: FileInfo
				if (request.id !== undefined) {
					const row = o.store.get('SELECT * FROM functions WHERE id = ?', request.id)
					if (!row) {
						return failed(
							`There is no function with id ${request.id}. Ids are re-issued when a file is re-read; look the function up again.`,
						)
					}
					info = files.byIdOrThrow(Number(row.file_id))
					rows = [row]
					total = 1
				} else if (request.path !== undefined && request.name !== undefined) {
					const found = fileAt(o, files, request.path)
					if ('error' in found) return failed(found.error)
					// Names are looked up AFTER the file is made current, or a rename
					// would answer from rows that no longer exist.
					const fresh = await readVerified(o.store, files, o.root, found, { refresh: true })
					if ('error' in fresh) return failed(fresh.error)
					info = fresh.info
					total = Number(
						(
							o.store.get(
								'SELECT count(*) AS n FROM functions WHERE file_id = ? AND name = ?',
								info.id,
								request.name,
							) as Row
						).n,
					)
					rows = o.store.all(
						'SELECT * FROM functions WHERE file_id = ? AND name = ? ORDER BY start LIMIT ? OFFSET ?',
						info.id,
						request.name,
						limit,
						cursor.offset,
					)
				} else {
					return failed('functionSource needs `id`, or `path` together with `name`.')
				}

				const verified = await readVerified(o.store, files, o.root, info, {
					refresh: request.id === undefined,
				})
				if ('error' in verified) return failed(verified.error)
				const items: AnalysisFunctionSource[] = rows.map((row) => {
					const fn = toFunction(row, verified.info)
					return {
						function: fn,
						parents: parentsOf(
							o.store,
							files,
							row.parent_id === null ? null : Number(row.parent_id),
						),
						source: sliceOf(verified.text, fn.start, fn.end, maxChars),
					}
				})
				const next = cursor.offset + items.length
				return {
					kind: 'ok',
					value: {
						items,
						total,
						...(next < total ? { nextCursor: encodeCursor({ g: generation, o: next, q }) } : {}),
					},
					evidence: evidence(
						[
							`${total} function(s) ${request.id !== undefined ? `with id ${request.id}` : `named ${JSON.stringify(request.name)} in ${info.rel}`}`,
							'the source is the exact slice of the file, verified against its content hash',
						],
						request.id === undefined
							? [
									'a function is matched by the name the index inferred for it, which for an unnamed function is the variable or property it was assigned to',
								]
							: [],
						info.parseErrors > 0 ? [parseGap(info)] : [],
						built,
					),
				}
			}),

		callersOf: (request: CallersOfRequest) =>
			withIndex(request.root, async (o, built) => {
				const files = new Files(o.store, o.root)
				const scope = request.scope ?? 'file'
				const member = request.match === 'member'
				let scoped: { sql: string; params: unknown[] }
				const gaps: string[] = []
				const notes: string[] = []
				if (scope === 'file') {
					if (request.path === undefined) {
						return failed(
							'callersOf with the default file scope needs `path`. Ask for scope "workspace" to search the whole index.',
						)
					}
					const found = fileAt(o, files, request.path)
					if ('error' in found) return failed(found.error)
					const fresh = await readVerified(o.store, files, o.root, found, { refresh: true })
					if ('error' in fresh) return failed(fresh.error)
					if (fresh.refreshed)
						notes.push(`${fresh.info.rel} had changed since it was indexed and was re-read`)
					if (fresh.info.parseErrors > 0) gaps.push(parseGap(fresh.info))
					scoped = { sql: ' AND c.file_id = ?', params: [fresh.info.id] }
				} else {
					const s = scopeSql(o, files, request.path, 'c.file_id')
					if ('error' in s) return failed(s.error)
					scoped = s
					gaps.push(...workspaceGaps(o.store))
				}
				const limit = clampLimit(request.limit)
				const generation = Number(o.store.meta('generation') ?? '0')
				const q = fingerprint(['callers', request.name, scope, request.path ?? null, member])
				const cursor = decodeCursor(request.cursor, generation, q)
				if ('error' in cursor) return failed(cursor.error)

				const test = member
					? "(c.callee = ? OR c.callee LIKE '%.' || ? ESCAPE '\\')"
					: 'c.callee = ?'
				const testParams = member ? [request.name, likeEscape(request.name)] : [request.name]
				const where = `WHERE ${test}${scoped.sql}`
				const params = [...testParams, ...scoped.params]
				const total = Number(
					(o.store.get(`SELECT count(*) AS n FROM calls c ${where}`, ...params) as Row).n,
				)
				const rows = o.store.all(
					`SELECT c.rowid AS rid, c.file_id, c.fn_id, c.start, c.callee, c.kind, c.nargs FROM calls c ${where} ORDER BY c.rowid LIMIT ? OFFSET ?`,
					...params,
					limit,
					cursor.offset,
				)
				const fnCache = new Map<number, ReturnType<typeof toFunction>>()
				const items: AnalysisCallSite[] = rows.map((r) => {
					const info = files.byIdOrThrow(Number(r.file_id))
					const at = position(info.starts, Number(r.start))
					let caller: ReturnType<typeof toFunction> | undefined
					if (r.fn_id !== null && r.fn_id !== undefined) {
						const id = Number(r.fn_id)
						caller = fnCache.get(id)
						if (!caller) {
							const fr = o.store.get('SELECT * FROM functions WHERE id = ?', id)
							if (fr) {
								caller = toFunction(fr, info)
								fnCache.set(id, caller)
							}
						}
					}
					return {
						path: info.abs,
						line: at.line,
						column: at.column,
						callee: String(r.callee),
						kind: String(r.kind) as AnalysisCallSite['kind'],
						argumentCount: Number(r.nargs),
						...(caller ? { caller } : {}),
					}
				})
				if (scope === 'workspace') {
					const stale = await staleFiles(
						files,
						rows.map((r) => Number(r.file_id)),
					)
					gaps.push(...staleReason(stale))
				}
				const distinct = Number(
					(
						o.store.get(
							`SELECT count(DISTINCT c.file_id) AS n FROM calls c ${where}`,
							...params,
						) as Row
					).n,
				)
				const next = cursor.offset + items.length
				return {
					kind: 'ok',
					value: {
						items,
						total,
						...(next < total ? { nextCursor: encodeCursor({ g: generation, o: next, q }) } : {}),
					},
					evidence: evidence(
						[
							`${total} call expression(s) whose callee text is ${member ? `${JSON.stringify(request.name)} or ends in .${request.name}` : JSON.stringify(request.name)}, in ${distinct} file(s)`,
							...notes,
						],
						[
							'callers are matched by the callee TEXT, not by scope or binding: two unrelated functions called by the same name are the same callee here',
							'a call through an alias, a destructured binding, .call/.apply or computed access (obj[name]()) is not matched',
							...(scope === 'workspace' && distinct > 1
								? [
										`the matches span ${distinct} files and may be different functions that share a name`,
									]
								: []),
						],
						gaps,
						built,
					),
				}
			}),

		imports: (request: ImportsRequest) =>
			withIndex(request.root, async (o, built) => {
				const files = new Files(o.store, o.root)
				const found = fileAt(o, files, request.path)
				if ('error' in found) return failed(found.error)
				const fresh = await readVerified(o.store, files, o.root, found, { refresh: true })
				if ('error' in fresh) return failed(fresh.error)
				const info = fresh.info
				const limit = clampLimit(request.limit)
				const generation = Number(o.store.meta('generation') ?? '0')
				const q = fingerprint(['imports', request.path])
				const cursor = decodeCursor(request.cursor, generation, q)
				if ('error' in cursor) return failed(cursor.error)

				const edges: AnalysisModuleEdge[] = [
					...o.store
						.all('SELECT * FROM imports WHERE file_id = ? ORDER BY start', info.id)
						.map((r): AnalysisModuleEdge => {
							const at = position(info.starts, Number(r.start))
							return {
								direction: 'import',
								kind: String(r.kind) as 'static',
								source: String(r.source),
								names: String(r.names) === '' ? [] : String(r.names).split(','),
								line: at.line,
								column: at.column,
							}
						}),
					...o.store
						.all('SELECT * FROM exports WHERE file_id = ? ORDER BY start', info.id)
						.map((r): AnalysisModuleEdge => {
							const at = position(info.starts, Number(r.start))
							return {
								direction: 'export',
								kind: String(r.kind) as 'named',
								name: String(r.name),
								...(r.source !== null && r.source !== undefined
									? { source: String(r.source) }
									: {}),
								line: at.line,
								column: at.column,
							}
						}),
				]
				const items = edges.slice(cursor.offset, cursor.offset + limit)
				const next = cursor.offset + items.length
				const imports = edges.filter((e) => e.direction === 'import').length
				return {
					kind: 'ok',
					value: {
						items,
						total: edges.length,
						...(next < edges.length
							? { nextCursor: encodeCursor({ g: generation, o: next, q }) }
							: {}),
					},
					evidence: evidence(
						[
							`${imports} import(s) and ${edges.length - imports} export(s) in ${info.rel}`,
							...(fresh.refreshed
								? [`${info.rel} had changed since it was indexed and was re-read`]
								: []),
						],
						['require() and import() are recorded only when their argument is a string literal'],
						info.parseErrors > 0 ? [parseGap(info)] : [],
						built,
					),
				}
			}),

		async dispose(): Promise<void> {
			const all = [...opened.values()]
			opened.clear()
			for (const pending of all) {
				const o = await pending
				if ('error' in o) continue
				// Behind any call still running, then closed.
				await o.store.run(async () => o.store.close()).catch(() => undefined)
			}
		},
	}
	return provider
}

function parseGap(info: FileInfo): string {
	return `${info.rel} had syntax errors; the parser kept whatever tree it could recover, which is often none, so rows from it may be missing`
}
