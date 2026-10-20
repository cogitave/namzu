import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'

import { encodeLineStarts } from './lines.js'
import type { RowSink } from './walk.js'

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
 * literal, which is correct and slower; the database records which mode it was
 * built in, and one made with FTS5 is rebuilt rather than half-served when the
 * running Node lacks it.
 */

export const SCHEMA_VERSION = 1

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
	mtime_ms REAL NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS functions(
	id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, parent_id INTEGER, kind TEXT NOT NULL, name TEXT,
	start INTEGER NOT NULL, "end" INTEGER NOT NULL, sline INTEGER NOT NULL, eline INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS strings(
	id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, fn_id INTEGER, start INTEGER NOT NULL,
	"end" INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls(
	file_id INTEGER NOT NULL, fn_id INTEGER, start INTEGER NOT NULL, "end" INTEGER NOT NULL,
	callee TEXT NOT NULL, kind TEXT NOT NULL, nargs INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS imports(
	file_id INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, names TEXT NOT NULL, start INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS exports(
	file_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, source TEXT, start INTEGER NOT NULL);
`

/** Built after a bulk load, not before: a first index inserts about twice as fast without them. */
const SECONDARY_INDEXES = `
CREATE INDEX IF NOT EXISTS fn_file_start ON functions(file_id, start);
CREATE INDEX IF NOT EXISTS fn_name ON functions(name);
CREATE INDEX IF NOT EXISTS str_fn ON strings(fn_id);
CREATE INDEX IF NOT EXISTS str_file ON strings(file_id, start);
CREATE INDEX IF NOT EXISTS call_callee ON calls(callee);
CREATE INDEX IF NOT EXISTS call_file ON calls(file_id, start);
CREATE INDEX IF NOT EXISTS imp_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS exp_file ON exports(file_id);
`

export interface FileRecord {
	readonly path: string
	readonly chars: number
	readonly lang: string
	readonly parseErrors: number
	readonly lineStarts: Uint32Array
	readonly size: number
	readonly mtimeMs: number
	readonly hash: string
	/** `sline` / `eline` are derived from this when functions are written. */
	readonly sink: RowSink
}

export interface StoredFile {
	readonly id: number
	readonly size: number
	readonly mtimeMs: number
	readonly hash: string
}

type Row = Record<string, unknown>

export class Store {
	private chain: Promise<unknown> = Promise.resolve()
	private readonly cache = new Map<string, StatementSync>()

	private constructor(
		readonly db: DatabaseSync,
		readonly persisted: boolean,
		readonly fts: boolean,
		private readonly location: string,
	) {}

	/**
	 * Open (or create) the database for `root`.
	 *
	 * `location` of `undefined` is an in-memory database. A file that cannot be
	 * opened, or that was made by a different schema, root or FTS mode, is
	 * deleted and made again: it is a cache, and rebuilding one is always
	 * correct while trusting a stale one is not.
	 */
	static async open(
		root: string,
		location: string | undefined,
		allowFts = true,
	): Promise<Store | undefined> {
		const mod = await loadSqlite()
		if (!mod) return undefined
		if (location !== undefined) {
			try {
				return Store.openAt(mod, root, location, allowFts)
			} catch {
				// Unreadable, corrupt or locked beyond the busy timeout: start over.
				try {
					rmSync(location, { force: true })
					rmSync(`${location}-wal`, { force: true })
					rmSync(`${location}-shm`, { force: true })
					return Store.openAt(mod, root, location, allowFts)
				} catch {
					// Not writable at all: an in-memory index still answers.
				}
			}
		}
		return Store.openAt(mod, root, undefined, allowFts)
	}

	private static openAt(
		mod: Sqlite,
		root: string,
		location: string | undefined,
		allowFts: boolean,
	): Store {
		if (location !== undefined) mkdirSync(dirname(location), { recursive: true, mode: 0o700 })
		let db = new mod.DatabaseSync(location ?? ':memory:')
		const ftsAvailable = allowFts && probeFts(db)
		if (location !== undefined) {
			db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
		}
		const existing = readMeta(db)
		const fresh =
			existing.size === 0 ||
			existing.get('schema') !== String(SCHEMA_VERSION) ||
			existing.get('root') !== root ||
			(existing.get('fts') === '1' && !ftsAvailable)
		if (!fresh)
			return new Store(
				db,
				location !== undefined,
				existing.get('fts') === '1',
				location ?? ':memory:',
			)

		if (location !== undefined && existing.size > 0) {
			db.close()
			rmSync(location, { force: true })
			rmSync(`${location}-wal`, { force: true })
			rmSync(`${location}-shm`, { force: true })
			db = new mod.DatabaseSync(location)
			db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
		} else if (existing.size > 0) {
			db.close()
			db = new mod.DatabaseSync(':memory:')
		}
		db.exec(TABLES)
		if (ftsAvailable) {
			db.exec(
				"CREATE VIRTUAL TABLE IF NOT EXISTS lit USING fts5(value, content='strings', content_rowid='id', tokenize='trigram');",
			)
		}
		const put = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
		put.run('schema', String(SCHEMA_VERSION))
		put.run('root', root)
		put.run('fts', ftsAvailable ? '1' : '0')
		put.run('generation', '0')
		put.run('next_fn_id', '1')
		put.run('built', '0')
		return new Store(db, location !== undefined, ftsAvailable, location ?? ':memory:')
	}

	/** Run `work` with the database to itself; calls queue in order. */
	run<T>(work: () => Promise<T>): Promise<T> {
		const next = this.chain.then(work, work)
		this.chain = next.catch(() => undefined)
		return next
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

	/** Every stored file keyed by path, for the incremental pass. */
	storedFiles(): Map<string, StoredFile> {
		const map = new Map<string, StoredFile>()
		for (const r of this.all('SELECT id, path, size, mtime_ms, hash FROM files')) {
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
		for (const table of ['strings', 'calls', 'functions', 'imports', 'exports']) {
			this.prepare(`DELETE FROM ${table} WHERE file_id = ?`).run(fileId)
		}
		this.prepare('DELETE FROM files WHERE id = ?').run(fileId)
	}

	/** Write one parsed file. The caller owns the surrounding transaction. */
	writeFile(record: FileRecord): number {
		const { sink, lineStarts } = record
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
		const insertFile = this.prepare(
			'INSERT INTO files(path, chars, lang, parse_errors, line_starts, size, mtime_ms, hash) VALUES(?,?,?,?,?,?,?,?)',
		)
		const result = insertFile.run(
			record.path,
			record.chars,
			record.lang,
			record.parseErrors,
			encodeLineStarts(lineStarts),
			record.size,
			record.mtimeMs,
			record.hash,
		)
		const id = Number(result.lastInsertRowid)

		const insFn = this.prepare('INSERT INTO functions VALUES(?,?,?,?,?,?,?,?,?)')
		for (const f of sink.functions) {
			insFn.run(
				f.id,
				id,
				f.parentId,
				f.kind,
				f.name,
				f.start,
				f.end,
				lineOf(f.start),
				lineOf(f.end),
			)
		}
		const insStr = this.prepare(
			'INSERT INTO strings(file_id, fn_id, start, "end", kind, value) VALUES(?,?,?,?,?,?)',
		)
		// The substring index is fed row by row from the ids just assigned. A
		// `SELECT … WHERE file_id = ?` here would scan the whole table once per
		// file during a first index, when the secondary indexes do not exist yet.
		const insLit = this.fts ? this.prepare('INSERT INTO lit(rowid, value) VALUES(?, ?)') : undefined
		for (const s of sink.strings) {
			const r = insStr.run(id, s.fnId, s.start, s.end, s.kind, s.value)
			if (insLit && s.value.length >= 3) insLit.run(Number(r.lastInsertRowid), s.value)
		}
		const insCall = this.prepare('INSERT INTO calls VALUES(?,?,?,?,?,?,?)')
		for (const c of sink.calls) insCall.run(id, c.fnId, c.start, c.end, c.callee, c.kind, c.nargs)
		const insImp = this.prepare('INSERT INTO imports VALUES(?,?,?,?,?)')
		for (const i of sink.imports) insImp.run(id, i.kind, i.source, i.names, i.start)
		const insExp = this.prepare('INSERT INTO exports VALUES(?,?,?,?,?)')
		for (const e of sink.exports) insExp.run(id, e.kind, e.name, e.source, e.start)
		return id
	}

	close(): void {
		this.cache.clear()
		try {
			this.db.close()
		} catch {
			// Already closed.
		}
	}

	get where(): string {
		return this.location
	}
}

function probeFts(db: DatabaseSync): boolean {
	try {
		db.exec("CREATE VIRTUAL TABLE temp.__namzu_fts_probe USING fts5(x, tokenize='trigram')")
		db.exec('DROP TABLE temp.__namzu_fts_probe')
		return true
	} catch {
		return false
	}
}

function readMeta(db: DatabaseSync): Map<string, string> {
	const map = new Map<string, string>()
	try {
		for (const r of db.prepare('SELECT key, value FROM meta').all() as Row[]) {
			map.set(String(r.key), String(r.value))
		}
	} catch {
		// No meta table: a new database, or not ours.
	}
	return map
}
