import { describe, expect, it } from 'vitest'

import {
	INITIAL_SCHEMA_VERSION,
	SchemaVersionError,
	defineSchema,
	migrate,
	stamp,
} from '../schema.js'

/**
 * Every persisted read was `JSON.parse(raw) as T`. A record from an older
 * build arrived with fields missing and nothing said so; a record from a
 * NEWER build was read partially and, once written back, permanently lost
 * whatever this build did not understand.
 */

const V1 = defineSchema({ kind: 'thing', current: 1, migrations: {} })

const V3 = defineSchema({
	kind: 'thing',
	current: 3,
	migrations: {
		1: (r) => ({ ...r, addedInV2: true }),
		2: (r) => ({ ...r, addedInV3: true }),
	},
})

describe('reading an older record', () => {
	it('treats an unstamped record as the first version', () => {
		// Every file written before this mechanism existed IS version 1 —
		// by definition, not by assumption.
		const migrated = migrate<Record<string, unknown>>(V3, { name: 'legacy' })
		expect(migrated.addedInV2).toBe(true)
		expect(migrated.addedInV3).toBe(true)
		expect(migrated.schemaVersion).toBe(3)
	})

	it('runs only the steps that are missing', () => {
		const migrated = migrate<Record<string, unknown>>(V3, { schemaVersion: 2, name: 'x' })
		expect(migrated.addedInV2).toBeUndefined()
		expect(migrated.addedInV3).toBe(true)
	})

	it('leaves a current record alone apart from the stamp', () => {
		const migrated = migrate<Record<string, unknown>>(V3, { schemaVersion: 3, name: 'x' })
		expect(migrated).toEqual({ schemaVersion: 3, name: 'x' })
	})
})

describe('reading a newer record', () => {
	it('refuses rather than reading it partially', () => {
		expect(() => migrate(V1, { schemaVersion: 2, name: 'from the future' })).toThrow(
			SchemaVersionError,
		)
	})

	it('says what it found and what it understands', () => {
		try {
			migrate(V1, { schemaVersion: 7 })
			expect.unreachable()
		} catch (err) {
			const e = err as SchemaVersionError
			expect(e.found).toBe(7)
			expect(e.supported).toBe(1)
			// A refusal is recoverable by upgrading. A partial read that
			// gets written back is not.
			expect(e.message).toContain('Upgrade')
		}
	})
})

describe('declaring a schema', () => {
	it('rejects a gap in the migration chain at declaration time', () => {
		// Discovered here, not in production by a user whose session will
		// not open.
		expect(() => defineSchema({ kind: 'gappy', current: 3, migrations: { 1: (r) => r } })).toThrow(
			/no migration from version 2 to 3/,
		)
	})

	it('rejects a version below the first one', () => {
		expect(() => defineSchema({ kind: 'x', current: 0, migrations: {} })).toThrow(/integer >= 1/)
	})

	it('accepts a schema that has never migrated', () => {
		expect(() =>
			defineSchema({ kind: 'x', current: INITIAL_SCHEMA_VERSION, migrations: {} }),
		).not.toThrow()
	})
})

describe('stamping', () => {
	it('marks a record with the version this build writes', () => {
		expect(stamp(V3, { a: 1 })).toEqual({ a: 1, schemaVersion: 3 })
	})

	it('leaves an array untouched', () => {
		// There is nowhere on an array to put a field that survives
		// `JSON.stringify`, and wrapping it would change every file already
		// written.
		const list = [{ a: 1 }, { a: 2 }]
		expect(stamp(V3, list)).toEqual(list)
	})

	it('round-trips through JSON', () => {
		const written = JSON.stringify(stamp(V1, { name: 'x' }))
		expect(migrate<Record<string, unknown>>(V1, JSON.parse(written))).toEqual({
			name: 'x',
			schemaVersion: 1,
		})
	})

	it('passes a non-object through both ways', () => {
		expect(stamp(V3, null)).toBeNull()
		expect(migrate(V3, null)).toBeNull()
		expect(migrate(V3, [1, 2])).toEqual([1, 2])
	})
})
