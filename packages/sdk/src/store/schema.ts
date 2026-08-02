/**
 * Versioning for anything this SDK writes to disk and reads back.
 *
 * Every persisted read was `JSON.parse(raw) as T` — an unchecked cast with
 * no idea which version of the shape it was looking at. Three things
 * followed, all of them silent:
 *
 *  - A file written by an OLDER build was read as the current shape.
 *    Fields added since simply arrived as `undefined` and flowed into the
 *    runtime as though they had been there.
 *  - A file written by a NEWER build was read by an older one, which
 *    understood some of the fields and dropped the rest. Write it back and
 *    the rest are gone — the only one of these that destroys data.
 *  - Neither case produced an error, a warning, or a log line, so a
 *    resumed session that quietly lost half its state looked exactly like
 *    a session that never had it.
 *
 * The version is stamped as a field on the record rather than wrapping it
 * in an envelope, so every file already on disk stays readable: a record
 * with no version IS version 1, which is exactly what those files are.
 */

/** Records written without a stamp predate this and are that version. */
export const INITIAL_SCHEMA_VERSION = 1

/** Reserved key. Domain records must not use it. */
export const SCHEMA_VERSION_KEY = 'schemaVersion'

/** A step from one version to the next. Pure; runs on the parsed record. */
export type Migration = (record: Record<string, unknown>) => Record<string, unknown>

export interface SchemaDefinition {
	/** What this record is, for error messages. */
	readonly kind: string
	/** The version this build writes. */
	readonly current: number
	/**
	 * `migrations[n]` upgrades a version-`n` record to version `n+1`.
	 * Every step from {@link INITIAL_SCHEMA_VERSION} to `current` must be
	 * present, and that is checked when the schema is declared rather than
	 * when a stale file finally shows up — a gap discovered at read time is
	 * discovered in production, by a user whose session will not open.
	 */
	readonly migrations: Readonly<Record<number, Migration>>
}

export class SchemaVersionError extends Error {
	readonly kind: string
	readonly found: number
	readonly supported: number

	constructor(init: { kind: string; found: number; supported: number; message: string }) {
		super(init.message)
		this.name = 'SchemaVersionError'
		this.kind = init.kind
		this.found = init.found
		this.supported = init.supported
	}
}

export function defineSchema(definition: SchemaDefinition): SchemaDefinition {
	if (!Number.isInteger(definition.current) || definition.current < INITIAL_SCHEMA_VERSION) {
		throw new Error(
			`Schema "${definition.kind}": current version must be an integer >= ${INITIAL_SCHEMA_VERSION}, got ${definition.current}`,
		)
	}
	for (let from = INITIAL_SCHEMA_VERSION; from < definition.current; from++) {
		if (typeof definition.migrations[from] !== 'function') {
			throw new Error(
				`Schema "${definition.kind}": no migration from version ${from} to ${from + 1}. Every step must be present, or a record at version ${from} can never be read.`,
			)
		}
	}
	return definition
}

/**
 * Stamp a record with the version this build writes.
 *
 * An array is returned untouched: there is nowhere on it to put a field
 * that survives `JSON.stringify`, and wrapping it would change the shape
 * of every file already written. A file whose top level is an array is
 * therefore unversioned, which is a real limitation — a store that needs
 * to migrate one has to move it under an object first.
 */
export function stamp<T>(schema: SchemaDefinition, record: T): T {
	if (record === null || typeof record !== 'object' || Array.isArray(record)) return record
	return { ...(record as object), [SCHEMA_VERSION_KEY]: schema.current } as T
}

/**
 * Bring a parsed record up to the current version, or refuse.
 *
 * A record from the FUTURE is refused rather than read. Reading it with
 * today's parser means silently dropping the fields this build does not
 * know about — and if the caller writes it back, they are gone. A refusal
 * is recoverable by upgrading; a partial read that overwrites is not.
 */
export function migrate<T>(schema: SchemaDefinition, parsed: unknown): T {
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return parsed as T
	}

	const record = parsed as Record<string, unknown>
	const stamped = record[SCHEMA_VERSION_KEY]
	// A record with no stamp predates this mechanism, which makes it
	// version 1 by definition rather than by assumption.
	const found =
		typeof stamped === 'number' && Number.isInteger(stamped) ? stamped : INITIAL_SCHEMA_VERSION

	if (found > schema.current) {
		throw new SchemaVersionError({
			kind: schema.kind,
			found,
			supported: schema.current,
			message: `Refusing to read a "${schema.kind}" record written at schema version ${found}; this build understands up to ${schema.current}. Reading it would silently drop the fields this build does not know about, and writing it back would lose them. Upgrade to read this data.`,
		})
	}

	let migrated = record
	for (let from = found; from < schema.current; from++) {
		const step = schema.migrations[from]
		if (!step) {
			throw new SchemaVersionError({
				kind: schema.kind,
				found,
				supported: schema.current,
				message: `No migration from "${schema.kind}" schema version ${from} to ${from + 1}.`,
			})
		}
		migrated = step(migrated)
	}

	return { ...migrated, [SCHEMA_VERSION_KEY]: schema.current } as T
}
