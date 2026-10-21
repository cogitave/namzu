import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'

import { cacheKey } from './cache-key.js'
import { type EvictionPolicy, evictCaches, touchCache } from './evict.js'
import { abortError } from './host.js'
import { encodeLineStarts } from './lines.js'
import type { RowsPayload } from './walk.js'

/**
 * The index's storage: one SQLite database per root.
 *
 * `node:sqlite` is loaded on first use. It is a built-in, but loading it
 * costs start-up time and prints Node's experimental notice, and a host that
 * never indexes anything should pay for neither.
 *
 * ## Node versions
 *
 * `node:sqlite` needs no flag from Node 22.13. FTS5 — which the substring
 * index for `find_literal` is built on — is compiled in from 22.16 and was
 * absent from 22.13 through 22.15 (checked against the official binaries). On
 * those the store still works and `find_literal` falls back to scanning every
 * literal, which is correct and slower.
 *
 * ## One file per root, per schema, per mode
 *
 * The cache file is named by the root, the schema version and whether it has
 * the substring index: `<root hash>-v1-fts.sqlite`. Two CLI versions, or one
 * Node with FTS5 and one without, therefore never open the same file and never
 * have a reason to rebuild each other's. A database is deleted in exactly one
 * case: SQLite says it is not a database or is corrupt, which no reader can
 * use. A busy or locked database is somebody else's work in progress and is
 * waited for, never removed.
 *
 * ## Many processes
 *
 * Writers take the write lock up front (`BEGIN IMMEDIATE`) and wait for it
 * with an `await`, not with SQLite's busy handler: that handler sleeps
 * synchronously, and a terminal UI cannot afford to freeze while another
 * process finishes a long index. Everything that must be unique across
 * processes — the next function id, whether a file row already exists — is read
 * inside the transaction that uses it.
 */

export const SCHEMA_VERSION = 2

type Sqlite = typeof import('node:sqlite')
let sqlite: Promise<Sqlite | undefined> | undefined

/** `undefined` when this Node has no `node:sqlite` at all (older than 22.5). */
export async function loadSqlite(): Promise<Sqlite | undefined> {
	sqlite ??= import('node:sqlite').catch(() => undefined)
	return await sqlite
}

const TABLES = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(
	id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, chars INTEGER NOT NULL, lang TEXT NOT NULL,
	parse_errors INTEGER NOT NULL, line_starts BLOB NOT NULL, size INTEGER NOT NULL,
	mtime_ms REAL NOT NULL, hash TEXT NOT NULL, degraded INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS dirs(path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL);
CREATE TABLE IF NOT EXISTS excl(
	path TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL,
	PRIMARY KEY(path, kind, name));
CREATE TABLE IF NOT EXISTS functions(
	id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, parent_id INTEGER, kind TEXT NOT NULL, name TEXT,
	start INTEGER NOT NULL, "end" INTEGER NOT NULL, sline INTEGER NOT NULL, eline INTEGER NOT NULL,
	qname TEXT);
CREATE TABLE IF NOT EXISTS classes(
	file_id INTEGER NOT NULL, name TEXT, start INTEGER NOT NULL, "end" INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS strings(
	id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, fn_id INTEGER, start INTEGER NOT NULL,
	"end" INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, cut INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS calls(
	file_id INTEGER NOT NULL, fn_id INTEGER, start INTEGER NOT NULL, "end" INTEGER NOT NULL,
	callee TEXT NOT NULL, kind TEXT NOT NULL, nargs INTEGER NOT NULL, owner TEXT, unres INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS imports(
	file_id INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, names TEXT NOT NULL, start INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS exports(
	file_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, source TEXT, start INTEGER NOT NULL);
`

/** Built after a bulk load, not before: a first index inserts about twice as fast without them. */
const SECONDARY_INDEXES = `
CREATE INDEX IF NOT EXISTS fn_file_start ON functions(file_id, start);
CREATE INDEX IF NOT EXISTS fn_name ON functions(name);
CREATE INDEX IF NOT EXISTS fn_qname ON functions(qname) WHERE qname IS NOT NULL;
CREATE INDEX IF NOT EXISTS class_file ON classes(file_id, start);
CREATE INDEX IF NOT EXISTS str_cut ON strings(file_id) WHERE cut > 0;
CREATE INDEX IF NOT EXISTS call_unres ON calls(file_id) WHERE unres = 1;
CREATE INDEX IF NOT EXISTS str_fn ON strings(fn_id);
CREATE INDEX IF NOT EXISTS str_file ON strings(file_id, start);
CREATE INDEX IF NOT EXISTS call_callee ON calls(callee);
CREATE INDEX IF NOT EXISTS call_file ON calls(file_id, start);
CREATE INDEX IF NOT EXISTS imp_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS exp_file ON exports(file_id);
`

/** A parse that died. `parse_errors` of this value marks a file recorded with no rows. */
export const CRASHED = -1

export interface FileRecord {
	readonly path: string
	readonly chars: number
	readonly lang: string
	readonly parseErrors: number
	/** 1: read after blanking broken lines; 2: read by the tolerant scanner. */
	readonly degraded: number
	readonly lineStarts: Uint32Array
	readonly size: number
	readonly mtimeMs: number
	readonly hash: string
	readonly rows: RowsPayload
}

export interface StoredFile {
	readonly id: number
	readonly size: number
	readonly mtimeMs: number
	readonly hash: string
}

type Row = Record<string, unknown>

/** How long a writer waits for another process's transaction before giving up. */
const WRITE_LOCK_WAIT_MS = 120_000

export function isBusy(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err)
	return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)
}

function isCorrupt(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err)
	return /file is not a database|database disk image is malformed|SQLITE_NOTADB|SQLITE_CORRUPT/i.test(
		message,
	)
}

export class Store {
	private chain: Promise<unknown> = Promise.resolve()
	private readonly cache = new Map<string, StatementSync>()

	private constructor(
		readonly db: DatabaseSync,
		readonly persisted: boolean,
		readonly fts: boolean,
	) {}

	/**
	 * Open (or create) the database for `root`.
	 *
	 * `cacheDir` of `undefined` is an in-memory database. A directory that
	 * cannot be written falls back to memory rather than failing the tool: an
	 * index that does not persist is slower next launch, not wrong.
	 */
	static async open(
		root: string,
		cacheDir: string | undefined,
		allowFts = true,
		eviction?: EvictionPolicy,
	): Promise<Store | undefined> {
		const mod = await loadSqlite()
		if (!mod) return undefined
		// The capability is probed on a private in-memory database, so a busy
		// cache file can never make it read as "FTS5 is missing" — a wrong
		// answer that used to be written into the cache for good.
		const fts = allowFts && probeFts(mod)
		if (cacheDir !== undefined) {
			const location = join(
				cacheDir,
				`${cacheKey(root)}-v${SCHEMA_VERSION}-${fts ? 'fts' : 'scan'}.sqlite`,
			)
			const deadline = Date.now() + WRITE_LOCK_WAIT_MS
			let corruptSeen = false
			for (;;) {
				try {
					const store = Store.openAt(mod, root, location, fts)
					// Mark it used, then trim the cache directory (best effort, off the
					// caller's path).
					await touchCache(location)
					if (eviction) void evictCaches(cacheDir, location.slice(cacheDir.length + 1), eviction)
					return store
				} catch (err) {
					if (isBusy(err) && Date.now() < deadline) {
						await sleep(50)
						continue
					}
					if (isCorrupt(err) && !corruptSeen) {
						// Unusable by anyone. The only case a cache file is removed.
						corruptSeen = true
						for (const suffix of ['', '-wal', '-shm'])
							rmSync(`${location}${suffix}`, { force: true })
						continue
					}
					break
				}
			}
		}
		return Store.openAt(mod, root, undefined, fts)
	}

	private static openAt(
		mod: Sqlite,
		root: string,
		location: string | undefined,
		fts: boolean,
	): Store {
		if (location !== undefined) mkdirSync(join(location, '..'), { recursive: true, mode: 0o700 })
		const db = new mod.DatabaseSync(location ?? ':memory:')
		try {
			// A short handler: it blocks the thread while it waits. Longer waits are
			// the caller's, with an `await` (see `begin`).
			db.exec('PRAGMA busy_timeout=250')
			if (location !== undefined) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
			// Already set up by a previous run or another process: take no lock at
			// all. Waiting for the write lock here would stall every reader behind
			// an index another process is in the middle of.
			const existing = readRoot(db)
			if (existing !== undefined) {
				if (existing !== root) throw new Error('cache file belongs to a different root')
				return new Store(db, location !== undefined, fts)
			}
			db.exec('BEGIN IMMEDIATE')
			try {
				db.exec(TABLES)
				if (fts) {
					db.exec(
						"CREATE VIRTUAL TABLE IF NOT EXISTS lit USING fts5(value, content='strings', content_rowid='id', tokenize='trigram');",
					)
				}
				// OR IGNORE: two processes creating the same file must not reset the
				// counters the first one has already advanced.
				const put = db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)')
				put.run('schema', String(SCHEMA_VERSION))
				put.run('root', root)
				put.run('fts', fts ? '1' : '0')
				put.run('generation', '0')
				put.run('next_fn_id', '1')
				put.run('covered', '[]')
				const stored = db.prepare("SELECT value FROM meta WHERE key = 'root'").get() as {
					value: string
				}
				if (stored.value !== root) throw new Error('cache file belongs to a different root')
				db.exec('COMMIT')
			} catch (err) {
				try {
					db.exec('ROLLBACK')
				} catch {
					// No transaction left.
				}
				throw err
			}
		} catch (err) {
			db.close()
			throw err
		}
		return new Store(db, location !== undefined, fts)
	}

	/** Run `work` with this process's use of the database to itself; calls queue in order. */
	run<T>(work: () => Promise<T>): Promise<T> {
		const next = this.chain.then(work, work)
		this.chain = next.catch(() => undefined)
		return next
	}

	/**
	 * Take the write lock, waiting for another process if it holds it.
	 *
	 * `BEGIN IMMEDIATE`: a deferred `BEGIN` reads first and fails with
	 * "database is locked" at the first write when another process got there,
	 * which is the shape the concurrent-refresh failures took.
	 */
	async begin(signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + WRITE_LOCK_WAIT_MS
		for (;;) {
			if (signal?.aborted) throw abortError()
			try {
				this.db.exec('BEGIN IMMEDIATE')
				return
			} catch (err) {
				if (!isBusy(err) || Date.now() >= deadline) throw err
				await sleep(40, undefined, signal ? { signal } : undefined).catch(() => {
					throw abortError()
				})
			}
		}
	}

	commit(): void {
		this.db.exec('COMMIT')
	}

	rollback(): void {
		try {
			this.db.exec('ROLLBACK')
		} catch {
			// Nothing to roll back.
		}
	}

	prepare(sql: string): StatementSync {
		let stmt = this.cache.get(sql)
		if (!stmt) {
			stmt = this.db.prepare(sql)
			this.cache.set(sql, stmt)
		}
		return stmt
	}

	all(sql: string, ...params: unknown[]): Row[] {
		return this.prepare(sql).all(...(params as never[])) as Row[]
	}

	get(sql: string, ...params: unknown[]): Row | undefined {
		return this.prepare(sql).get(...(params as never[])) as Row | undefined
	}

	exec(sql: string): void {
		this.db.exec(sql)
	}

	meta(key: string): string | undefined {
		const row = this.get('SELECT value FROM meta WHERE key = ?', key)
		return row ? String(row.value) : undefined
	}

	setMeta(key: string, value: string): void {
		this.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(key, value)
	}

	bumpGeneration(): number {
		const next = Number(this.meta('generation') ?? '0') + 1
		this.setMeta('generation', String(next))
		return next
	}

	ensureIndexes(): void {
		this.db.exec(SECONDARY_INDEXES)
	}

	/** Every stored file at or under `scope` (a relative path; empty is all), keyed by path. */
	storedFiles(scope: string): Map<string, StoredFile> {
		const map = new Map<string, StoredFile>()
		const rows =
			scope === ''
				? this.all('SELECT id, path, size, mtime_ms, hash FROM files')
				: this.all(
						'SELECT id, path, size, mtime_ms, hash FROM files WHERE path = ? OR (path >= ? AND path < ?)',
						scope,
						`${scope}/`,
						`${scope}0`,
					)
		for (const r of rows) {
			map.set(String(r.path), {
				id: Number(r.id),
				size: Number(r.size),
				mtimeMs: Number(r.mtime_ms),
				hash: String(r.hash),
			})
		}
		return map
	}

	/** Remove a file and every row that hangs off it. */
	removeFile(fileId: number): void {
		if (this.fts) {
			// External-content FTS5 must be told what to forget, with the values
			// it indexed, BEFORE the rows are gone.
			this.prepare(
				"INSERT INTO lit(lit, rowid, value) SELECT 'delete', id, value FROM strings WHERE file_id = ? AND length(value) >= 3",
			).run(fileId)
		}
		for (const table of ['strings', 'calls', 'functions', 'classes', 'imports', 'exports']) {
			this.prepare(`DELETE FROM ${table} WHERE file_id = ?`).run(fileId)
		}
		this.prepare('DELETE FROM files WHERE id = ?').run(fileId)
	}

	removeByPath(path: string): boolean {
		const row = this.get('SELECT id FROM files WHERE path = ?', path)
		if (!row) return false
		this.removeFile(Number(row.id))
		return true
	}

	/**
	 * Write one parsed file and return how many function ids it used.
	 *
	 * Must run inside a transaction that holds the write lock: the first id is
	 * read from `meta` here, so two processes can never hand out the same one,
	 * and a row another process wrote for this path in the meantime is replaced
	 * rather than colliding with it.
	 */
	writeFile(record: FileRecord): void {
		const { rows, lineStarts } = record
		this.removeByPath(record.path)
		const base = Number(this.meta('next_fn_id') ?? '1')
		const lineOf = (offset: number): number => {
			let lo = 0
			let hi = lineStarts.length - 1
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1
				if ((lineStarts[mid] as number) <= offset) lo = mid
				else hi = mid - 1
			}
			return lo + 1
		}
		const result = this.prepare(
			'INSERT INTO files(path, chars, lang, parse_errors, line_starts, size, mtime_ms, hash, degraded) VALUES(?,?,?,?,?,?,?,?,?)',
		).run(
			record.path,
			record.chars,
			record.lang,
			record.parseErrors,
			encodeLineStarts(lineStarts),
			record.size,
			record.mtimeMs,
			record.hash,
			record.degraded,
		)
		const id = Number(result.lastInsertRowid)
		const remap = (local: number | null): number | null => (local === null ? null : base + local)

		const insFn = this.prepare('INSERT INTO functions VALUES(?,?,?,?,?,?,?,?,?,?)')
		for (const f of rows.functions) {
			insFn.run(
				base + f.id,
				id,
				remap(f.parentId),
				f.kind,
				f.name,
				f.start,
				f.end,
				lineOf(f.start),
				lineOf(f.end),
				f.qname !== null && f.qname !== f.name ? f.qname : null,
			)
		}
		const insClass = this.prepare('INSERT INTO classes VALUES(?,?,?,?)')
		for (const c of rows.classes) insClass.run(id, c.name, c.start, c.end)
		const insStr = this.prepare(
			'INSERT INTO strings(file_id, fn_id, start, "end", kind, value, cut) VALUES(?,?,?,?,?,?,?)',
		)
		// The substring index is fed row by row from the ids just assigned. A
		// `SELECT … WHERE file_id = ?` here would scan the whole table once per
		// file during a first index, when the secondary indexes do not exist yet.
		const insLit = this.fts ? this.prepare('INSERT INTO lit(rowid, value) VALUES(?, ?)') : undefined
		for (const s of rows.strings) {
			const r = insStr.run(id, remap(s.fnId), s.start, s.end, s.kind, s.value, s.cut)
			if (insLit && s.value.length >= 3) insLit.run(Number(r.lastInsertRowid), s.value)
		}
		const insCall = this.prepare('INSERT INTO calls VALUES(?,?,?,?,?,?,?,?,?)')
		for (const c of rows.calls) {
			// A callee the index cannot name: not an identifier or a member path.
			const unresolved = c.callee === '?' || c.callee.endsWith('[]') ? 1 : 0
			insCall.run(id, remap(c.fnId), c.start, c.end, c.callee, c.kind, c.nargs, c.owner, unresolved)
		}
		const insImp = this.prepare('INSERT INTO imports VALUES(?,?,?,?,?)')
		for (const i of rows.imports) insImp.run(id, i.kind, i.source, i.names, i.start)
		const insExp = this.prepare('INSERT INTO exports VALUES(?,?,?,?,?)')
		for (const e of rows.exports) insExp.run(id, e.kind, e.name, e.source, e.start)
		this.setMeta('next_fn_id', String(base + rows.functions.length))
	}

	close(): void {
		this.cache.clear()
		try {
			this.db.close()
		} catch {
			// Already closed.
		}
	}
}

/** The root a cache file says it belongs to, or `undefined` when it is not set up yet. */
function readRoot(db: DatabaseSync): string | undefined {
	try {
		const row = db.prepare("SELECT value FROM meta WHERE key = 'root'").get() as
			| { value: string }
			| undefined
		return row?.value
	} catch {
		return undefined
	}
}

/** Whether this Node's SQLite has FTS5 with the trigram tokenizer, asked of a private database. */
function probeFts(mod: Sqlite): boolean {
	const db = new mod.DatabaseSync(':memory:')
	try {
		db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')")
		return true
	} catch {
		return false
	} finally {
		db.close()
	}
}
