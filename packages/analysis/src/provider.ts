import { lstat, realpath, stat } from 'node:fs/promises'

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
	type Env,
	type FileInfo,
	Files,
	PREVIEW_CHARS,
	StaleIndexError,
	checkFreshness,
	clampChars,
	clampLimit,
	coverageOf,
	decodeCursor,
	encodeCursor,
	fingerprint,
	markReasons,
	newFileReasons,
	parentsOf,
	readVerified,
	sliceOf,
	toFunction,
	workspaceGaps,
} from './context.js'
import { DEFAULT_CACHE_MAX_AGE_DAYS, DEFAULT_CACHE_MAX_BYTES } from './evict.js'
import { ParserHost, abortError } from './host.js'
import {
	DEFAULT_IGNORED_DIRS,
	DEFAULT_MAX_DIRECTORIES,
	DEFAULT_MAX_FILES,
	DEFAULT_MAX_FILE_BYTES,
	DEFAULT_MAX_MILLIS,
	type IndexOptions,
	coveringEntry,
	readCovered,
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
	 * Directories one call walks before it stops and reports what it has.
	 * Default 20,000. Reaching it is not an error: see {@link IndexSummary.truncated}.
	 */
	readonly maxDirectories?: number
	/** Milliseconds one call spends before it stops the same way. Default 45,000. */
	readonly maxMillis?: number
	/**
	 * Path of the script to fork as the parsing child. Absent: this package's
	 * own `dist/indexer-host.js`. A host that bundles this package emits that
	 * entry itself (`@namzu/analysis/indexer-host`) and names it here.
	 */
	readonly hostScript?: string
	/**
	 * Load the parser from this module specifier instead of `oxc-parser`. For a
	 * host that vendors the parser, and for tests; the child is started with it
	 * as an argument, and without Node's permission model, which needs to know
	 * where the parser lives.
	 */
	readonly parserModule?: string
	/** Remove cache databases unused for this many days. Default 30. */
	readonly cacheMaxAgeDays?: number
	/** Trim least recently used cache databases until the directory fits. Default 2 GiB. */
	readonly cacheMaxBytes?: number
	/**
	 * `auto` (default) builds a trigram FTS5 index of literals when this Node
	 * has FTS5 (22.16 and newer). `off` never does, and `find_literal` scans.
	 * The two modes use separate cache files.
	 */
	readonly substringIndex?: 'auto' | 'off'
}

type Row = Record<string, unknown>
type Result<T> = CodeAnalysisResult<T>

const failed = <T>(error: string): Result<T> => ({ kind: 'failed', error })

/** An exception inside a query, as the answer it is. */
function explain<T>(err: unknown): Result<T> {
	if (err instanceof ParserUnavailableError) return { kind: 'unsupported', reason: err.message }
	if (err instanceof Error && err.name === 'AbortError') {
		return failed(
			'The call was cancelled. Anything already indexed is kept, so the next call continues from there.',
		)
	}
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
 * Requests for one root queue behind each other, requests for different roots
 * do not. Parsing happens in a child process (see `indexer-host.ts`), so a
 * parser crash costs one file, not the host process, and the host's event loop
 * stays free during an index.
 *
 * Nothing heavy is loaded until the first call: `node:sqlite` on the first
 * store, the child process on the first parse.
 */
export function createCodeAnalysisProvider(
	options: CodeAnalysisOptions = {},
): CodeAnalysisProvider {
	const opened = new Map<string, Promise<Opened | { error: string }>>()
	const host = new ParserHost(options.hostScript, options.parserModule)
	/** Fires on dispose: every call still running or queued stops. */
	const lifetime = new AbortController()
	const withLifetime = (signal: AbortSignal | undefined): AbortSignal =>
		signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal
	const indexOptions = (force: boolean): IndexOptions => ({
		ignoreDirs: options.ignoreDirs ?? DEFAULT_IGNORED_DIRS,
		maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
		maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
		maxDirectories: options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
		maxMillis: options.maxMillis ?? DEFAULT_MAX_MILLIS,
		force,
	})
	const envOf = (o: Opened, signal: AbortSignal | undefined, force = false): Env => ({
		store: o.store,
		root: o.root,
		host,
		options: indexOptions(force),
		signal,
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
				const store = await Store.open(root, options.cacheDir, options.substringIndex !== 'off', {
					maxAgeDays: options.cacheMaxAgeDays ?? DEFAULT_CACHE_MAX_AGE_DAYS,
					maxBytes: options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES,
				})
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
			void pending.then(
				(r) => {
					if ('error' in r) opened.delete(root)
				},
				() => opened.delete(root),
			)
		}
		return await pending
	}

	/**
	 * Run `work` against a root's store behind this process's other calls, and
	 * stop waiting if the caller's signal fires. A call that was queued and then
	 * cancelled never starts: `work` checks the signal first.
	 */
	async function queued<T>(
		o: Opened,
		signal: AbortSignal | undefined,
		work: () => Promise<Result<T>>,
	): Promise<Result<T>> {
		const guarded = o.store.run(async () => {
			if (signal?.aborted) throw abortError()
			return await work()
		})
		if (!signal) return await guarded.catch(explain<T>)
		let onAbort: (() => void) | undefined
		const cancelled = new Promise<Result<T>>((resolve) => {
			onAbort = () => resolve(explain<T>(abortError()))
			if (signal.aborted) onAbort()
			else signal.addEventListener('abort', onAbort, { once: true })
		})
		try {
			return await Promise.race([guarded.catch(explain<T>), cancelled])
		} finally {
			if (onAbort) signal.removeEventListener('abort', onAbort)
		}
	}

	/**
	 * Make sure `scopeAbs` has been indexed, building it if not. The returned
	 * note says so, because the first call taking seconds is something the
	 * reader should be told, not left to infer. Reaching a limit is reported
	 * through coverage, not refused.
	 */
	async function ensureCovered(env: Env, scopeAbs: string): Promise<string | undefined> {
		const rel = toRel(env.root, scopeAbs)
		if (rel === undefined) return undefined
		if (coveringEntry(readCovered(env.store), rel)) return undefined
		// A scope that does not exist is not worth recording as covered.
		if (
			rel !== '' &&
			!(await lstat(scopeAbs).then(
				() => true,
				() => false,
			))
		)
			return undefined
		const started = performance.now()
		const out = await refreshIndex(env.store, env.root, scopeAbs, env.options, env.host, env.signal)
		return `${rel === '' ? `the index for ${env.root}` : `${rel}`} was not indexed and was built for this call: ${out.indexed} files in ${Math.round(performance.now() - started)} ms${out.truncated ? ` (${out.truncated})` : ''}`
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
	): { sql: string; params: unknown[]; rel: string } | { error: string } {
		if (path === undefined) return { sql: '', params: [], rel: '' }
		const rel = toRel(o.root, path)
		if (rel === undefined) return { error: `${path} is outside the indexed root ${o.root}.` }
		if (rel === '') return { sql: '', params: [], rel }
		const file = files.byPath(rel)
		if (file) return { sql: ` AND ${column} = ?`, params: [file.id], rel }
		return {
			sql: ` AND ${column} IN (SELECT id FROM files WHERE path >= ? AND path < ?)`,
			params: [`${rel}/`, `${rel}0`],
			rel,
		}
	}

	/** Open a root and run `body` against it, building the part of the index it needs first. */
	async function withScope<T>(
		rootInput: string,
		scopeAbs: string | undefined,
		signal: AbortSignal | undefined,
		body: (o: Opened, env: Env, built: string | undefined) => Promise<Result<T>>,
	): Promise<Result<T>> {
		const o = await open(rootInput)
		if ('error' in o) return { kind: 'unsupported', reason: o.error }
		const lifetimeSignal = withLifetime(signal)
		return await queued(o, lifetimeSignal, async () => {
			const env = envOf(o, lifetimeSignal)
			const built = await ensureCovered(env, scopeAbs ?? o.root)
			// Several processes may be rewriting the same files. A read that finds a
			// row replaced under it is run again against the new rows.
			for (let attempt = 0; ; attempt++) {
				try {
					return await body(o, env, built)
				} catch (err) {
					if (!(err instanceof StaleIndexError) || attempt >= 4) throw err
				}
			}
		})
	}

	const provider: CodeAnalysisProvider = {
		async index(request: IndexRequest): Promise<Result<IndexSummary>> {
			const o = await open(request.root)
			if ('error' in o) return { kind: 'unsupported', reason: o.error }
			const signal = withLifetime(request.signal)
			return await queued(o, signal, async () => {
				const started = performance.now()
				const scopeAbs = request.scope ?? o.root
				const scopeRel = toRel(o.root, scopeAbs)
				if (scopeRel === undefined)
					return failed(`${scopeAbs} is outside the indexed root ${o.root}.`)
				const out = await refreshIndex(
					o.store,
					o.root,
					scopeAbs,
					indexOptions(request.force === true),
					host,
					signal,
				)
				const count = (table: string): number =>
					Number((o.store.get(`SELECT count(*) AS n FROM ${table}`) as Row).n)
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
					...(out.truncated
						? {
								truncated: `Indexing ${scopeRel === '' ? 'the root' : scopeRel} ${out.truncated}, so the index is partial. Index a narrower path to cover the rest; what was indexed is kept and answers queries now.`,
							}
						: {}),
				}
				return {
					kind: 'ok',
					value: summary,
					evidence: evidence(
						[
							`walked ${scopeRel === '' ? o.root : scopeRel}: ${out.parsed} file(s) parsed, ${out.unchanged} unchanged by size, mtime or content hash, ${out.removed} removed`,
						],
						o.store.fts
							? []
							: [
									'this Node.js has no FTS5, so find_literal scans every literal instead of using a substring index; answers are the same, slower',
								],
						workspaceGaps(o.store, scopeRel),
					),
				}
			})
		},

		findLiteral: (request: FindLiteralRequest) =>
			withScope(request.root, request.path, request.signal, async (o, _env, built) => {
				const files = new Files(o.store, o.root)
				const scope = scopeSql(o, files, request.path, 's.file_id')
				if ('error' in scope) return failed(scope.error)
				const limit = clampLimit(request.limit)
				const insensitive = request.caseSensitive === false
				// The trigram tokenizer needs three CODE POINTS. Counting UTF-16 units
				// would send "😀😀" (four units, two points) to an index that cannot
				// match it, and report no hits with complete coverage.
				const codePoints = Array.from(request.text).length
				const useFts = o.store.fts && codePoints >= 3
				const test = insensitive ? 'instr(lower(s.value), lower(?)) > 0' : 'instr(s.value, ?) > 0'
				const prefilter = useFts ? ' AND s.id IN (SELECT rowid FROM lit WHERE lit MATCH ?)' : ''
				const where = `WHERE ${test}${prefilter}${scope.sql}`
				const params: unknown[] = [
					request.text,
					...(useFts ? [`"${request.text.replaceAll('"', '""')}"`] : []),
					...scope.params,
				]

				// Re-run when a file behind the page turns out to be a link: its rows
				// are dropped and must not appear.
				let offset = 0
				let rows: Row[] = []
				let total = 0
				let generation = 0
				let q = ''
				let fresh = await checkFreshness(o.store, files, o.root, [])
				for (let attempt = 0; attempt < 3; attempt++) {
					generation = Number(o.store.meta('generation') ?? '0')
					q = fingerprint(['find', o.root, request.text, request.path ?? null, insensitive])
					const cursor = decodeCursor(request.cursor, generation, q)
					if ('error' in cursor) return failed(cursor.error)
					offset = cursor.offset
					total = Number(
						(o.store.get(`SELECT count(*) AS n FROM strings s ${where}`, ...params) as Row).n,
					)
					rows = o.store.all(
						`SELECT s.id, s.file_id, s.fn_id, s.start, s."end", s.kind, s.value FROM strings s ${where} ORDER BY s.id LIMIT ? OFFSET ?`,
						...params,
						limit,
						offset,
					)
					fresh = await checkFreshness(
						o.store,
						files,
						o.root,
						rows.map((r) => Number(r.file_id)),
					)
					if (fresh.dropped.length === 0) break
				}
				const fnCache = new Map<number, ReturnType<typeof toFunction>>()
				const items: AnalysisLiteralHit[] = rows.map((r) => {
					const fileId = Number(r.file_id)
					const info = files.byIdOrThrow(fileId)
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
					const mark = fresh.marks.get(fileId)
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
						...(mark ? { stale: mark } : {}),
					}
				})
				const next = offset + items.length
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
						[
							...workspaceGaps(o.store, scope.rel),
							...markReasons(fresh.marks),
							...(await newFileReasons(o.store, o.root, scope.rel)),
						],
						built,
					),
				}
			}),

		enclosingFunction: (request: EnclosingFunctionRequest) =>
			withScope(request.root, request.path, request.signal, async (o, env, built) => {
				const files = new Files(o.store, o.root)
				const found = fileAt(o, files, request.path)
				if ('error' in found) return failed(found.error)
				const verified = await readVerified(env, files, found, { refresh: true })
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
				const gaps = fileGaps(info)
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
			withScope(
				request.root,
				// An id names a function the index already holds; only a path asks for a build.
				request.id === undefined ? request.path : undefined,
				request.signal,
				async (o, env, built) => {
					const files = new Files(o.store, o.root)
					const maxChars = clampChars(request.maxChars)
					const limit = clampLimit(request.limit)
					const generation = Number(o.store.meta('generation') ?? '0')
					const q = fingerprint([
						'source',
						o.root,
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
						const fresh = await readVerified(env, files, found, { refresh: true })
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

					const verified = await readVerified(env, files, info, {
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
							fileGaps(info),
							built,
						),
					}
				},
			),

		callersOf: (request: CallersOfRequest) => {
			const scope = request.scope ?? 'file'
			return withScope(request.root, request.path, request.signal, async (o, env, built) => {
				const files = new Files(o.store, o.root)
				const member = request.match === 'member'
				let scoped: { sql: string; params: unknown[] }
				let scopeRel = ''
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
					const fresh = await readVerified(env, files, found, { refresh: true })
					if ('error' in fresh) return failed(fresh.error)
					if (fresh.refreshed)
						notes.push(`${fresh.info.rel} had changed since it was indexed and was re-read`)
					gaps.push(...fileGaps(fresh.info))
					scoped = { sql: ' AND c.file_id = ?', params: [fresh.info.id] }
				} else {
					const s = scopeSql(o, files, request.path, 'c.file_id')
					if ('error' in s) return failed(s.error)
					scoped = s
					scopeRel = s.rel
				}
				const limit = clampLimit(request.limit)
				// `member` is the callee OR anything ending in `.name`, compared by
				// bytes: SQLite's LIKE folds ASCII case, which would match `obj.Run`
				// for `run` while the evidence says it matches `.run`.
				const test = member
					? "(c.callee = ? OR (length(c.callee) > length(?) AND substr(c.callee, -(length(?) + 1)) = '.' || ?))"
					: 'c.callee = ?'
				const testParams = member
					? [request.name, request.name, request.name, request.name]
					: [request.name]
				const where = `WHERE ${test}${scoped.sql}`
				const params = [...testParams, ...scoped.params]

				let offset = 0
				let rows: Row[] = []
				let total = 0
				let generation = 0
				let q = ''
				let freshness = await checkFreshness(o.store, files, o.root, [])
				for (let attempt = 0; attempt < 3; attempt++) {
					generation = Number(o.store.meta('generation') ?? '0')
					q = fingerprint(['callers', o.root, request.name, scope, request.path ?? null, member])
					const cursor = decodeCursor(request.cursor, generation, q)
					if ('error' in cursor) return failed(cursor.error)
					offset = cursor.offset
					total = Number(
						(o.store.get(`SELECT count(*) AS n FROM calls c ${where}`, ...params) as Row).n,
					)
					rows = o.store.all(
						`SELECT c.rowid AS rid, c.file_id, c.fn_id, c.start, c.callee, c.kind, c.nargs FROM calls c ${where} ORDER BY c.rowid LIMIT ? OFFSET ?`,
						...params,
						limit,
						offset,
					)
					freshness = await checkFreshness(
						o.store,
						files,
						o.root,
						rows.map((r) => Number(r.file_id)),
					)
					if (freshness.dropped.length === 0) break
				}
				const fnCache = new Map<number, ReturnType<typeof toFunction>>()
				const items: AnalysisCallSite[] = rows.map((r) => {
					const fileId = Number(r.file_id)
					const info = files.byIdOrThrow(fileId)
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
					const mark = freshness.marks.get(fileId)
					return {
						path: info.abs,
						line: at.line,
						column: at.column,
						callee: String(r.callee),
						kind: String(r.kind) as AnalysisCallSite['kind'],
						argumentCount: Number(r.nargs),
						...(caller ? { caller } : {}),
						...(mark ? { stale: mark } : {}),
					}
				})
				if (scope === 'workspace') {
					gaps.push(
						...workspaceGaps(o.store, scopeRel),
						...markReasons(freshness.marks),
						...(await newFileReasons(o.store, o.root, scopeRel)),
					)
				} else {
					gaps.push(...markReasons(freshness.marks))
				}
				const distinct = Number(
					(
						o.store.get(
							`SELECT count(DISTINCT c.file_id) AS n FROM calls c ${where}`,
							...params,
						) as Row
					).n,
				)
				const next = offset + items.length
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
			})
		},

		imports: (request: ImportsRequest) =>
			withScope(request.root, request.path, request.signal, async (o, env, built) => {
				const files = new Files(o.store, o.root)
				const found = fileAt(o, files, request.path)
				if ('error' in found) return failed(found.error)
				const fresh = await readVerified(env, files, found, { refresh: true })
				if ('error' in fresh) return failed(fresh.error)
				const info = fresh.info
				const limit = clampLimit(request.limit)
				const generation = Number(o.store.meta('generation') ?? '0')
				const q = fingerprint(['imports', o.root, request.path])
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
						fileGaps(info),
						built,
					),
				}
			}),

		async dispose(): Promise<void> {
			const all = [...opened.values()]
			opened.clear()
			// Stops every call still running or queued, and the child with them. A
			// call in flight returns a cancellation, not a result.
			lifetime.abort()
			host.dispose()
			for (const pending of all) {
				const o = await pending.catch(() => undefined)
				if (!o || 'error' in o) continue
				// Behind any call still running, then closed.
				await o.store.run(async () => o.store.close()).catch(() => undefined)
			}
		},
	}
	return provider
}

function fileGaps(info: FileInfo): string[] {
	if (info.parseErrors < 0) {
		return [
			`${info.rel} crashed the parser and is recorded with no rows, so nothing can be answered from it`,
		]
	}
	if (info.parseErrors > 0) {
		return [
			`${info.rel} had syntax errors; the parser kept whatever tree it could recover, which is often none, so rows from it may be missing`,
		]
	}
	return []
}
