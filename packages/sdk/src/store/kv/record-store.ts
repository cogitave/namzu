import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { atomicWriteFile } from '../../utils/atomic-write.js'
import { type SchemaDefinition, migrate, stamp } from '../schema.js'

/**
 * Read a record, write a record, walk a directory of them — once.
 *
 * Four disk stores each carried a private copy of the same twenty lines:
 * a `readFile` + `JSON.parse` + `migrate` with ENOENT collapsed to null, an
 * `atomicWriteFile` of `stamp`ed JSON, and a `readdir` filtered by prefix.
 * Every property fixed in one of them had to be remembered into the other
 * three, and the properties are not obvious ones — that a missing file is
 * an empty read rather than an error, that a record from a NEWER build is
 * refused rather than read partially and written back with the difference
 * gone, that a listing needs a stable order.
 *
 * Internal to the package. It is a shape four call sites already agree on,
 * not a contract offered to hosts, and exporting it would freeze an
 * argument list nobody outside has asked for.
 */
export class DiskRecordStore<T> {
	constructor(private readonly schema: SchemaDefinition) {}

	/**
	 * `null` for a file that is not there — the convention every copy of
	 * this already used, and the one worth stating once. A store asking
	 * "does this exist" through an exception has to distinguish ENOENT from
	 * a real IO failure at every call site, and the copies that got it
	 * right did so independently.
	 */
	async read(path: string): Promise<T | null> {
		try {
			const raw = await readFile(path, 'utf-8')
			// Through the schema, never a bare cast: a record from an older
			// build is brought forward, and one from a NEWER build is refused
			// rather than read partially and written back with the difference
			// silently gone.
			return migrate<T>(this.schema, JSON.parse(raw))
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw err
		}
	}

	/** Stamped with the current schema version, written atomically. */
	async write(path: string, value: T): Promise<void> {
		await atomicWriteFile(path, `${JSON.stringify(stamp(this.schema, value), null, 2)}\n`)
	}

	/**
	 * Entry names under `dir`, prefix-filtered and SORTED.
	 *
	 * The sort is not decoration. `readdir` order is filesystem-dependent,
	 * so a listing that skipped it would return records in an order that
	 * differs between a developer's machine and a container — which turns a
	 * pagination bug into one that reproduces nowhere.
	 *
	 * A missing directory lists as empty, for the same reason a missing
	 * file reads as null: "nothing has been written yet" is an ordinary
	 * state of a store, not a failure.
	 */
	async scanNames(dir: string, prefix: string): Promise<string[]> {
		try {
			const entries = await readdir(dir)
			return entries.filter((name) => name.startsWith(prefix)).sort()
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
			throw err
		}
	}

	/** Every record under `dir` whose name starts with `prefix`, in name order. */
	async *scan(dir: string, prefix: string, file = 'record.json'): AsyncIterable<T> {
		for (const name of await this.scanNames(dir, prefix)) {
			const record = await this.read(join(dir, name, file))
			// A directory whose record is absent or unreadable is skipped, not
			// fatal: a half-written entry from a crashed writer must not make
			// the whole listing unavailable.
			if (record !== null) yield record
		}
	}
}
