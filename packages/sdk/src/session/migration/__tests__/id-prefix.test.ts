import { beforeEach, describe, expect, it } from 'vitest'
import type { ProjectId } from '../../../types/session/ids.js'
import {
	NOOP_MIGRATION_WARNING_SINK,
	StalePrefixError,
	__resetSeenLegacyForTests,
	acceptLegacyContainerId,
	rejectLegacyContainerPrefix,
} from '../id-prefix.js'
import type { MigrationWarning, MigrationWarningSink } from '../id-prefix.js'

function collectingSink(): { emitted: MigrationWarning[]; sink: MigrationWarningSink } {
	const emitted: MigrationWarning[] = []
	return {
		emitted,
		sink: {
			emit(w) {
				emitted.push(w)
			},
		},
	}
}

describe('acceptLegacyContainerId', () => {
	beforeEach(() => {
		__resetSeenLegacyForTests()
	})

	it('coerces thd_* to prj_* and emits a warning on first encounter', () => {
		const { emitted, sink } = collectingSink()
		const result = acceptLegacyContainerId('thd_abc', sink)
		expect(result).toBe('prj_abc' as ProjectId)
		expect(emitted).toHaveLength(1)
		expect(emitted[0]?.kind).toBe('id_prefix_legacy_read')
		expect(emitted[0]?.legacyId).toBe('thd_abc')
		expect(emitted[0]?.normalizedId).toBe('prj_abc')
		expect(emitted[0]?.emittedOncePerProcess).toBe(true)
		expect(emitted[0]?.at).toBeInstanceOf(Date)
	})

	it('does NOT re-emit a warning for the same legacy id on a second call', () => {
		const { emitted, sink } = collectingSink()
		acceptLegacyContainerId('thd_abc', sink)
		acceptLegacyContainerId('thd_abc', sink)
		acceptLegacyContainerId('thd_abc', sink)
		expect(emitted).toHaveLength(1)
	})

	it('emits distinct warnings for distinct legacy ids', () => {
		const { emitted, sink } = collectingSink()
		acceptLegacyContainerId('thd_abc', sink)
		acceptLegacyContainerId('thd_xyz', sink)
		expect(emitted).toHaveLength(2)
		expect(emitted.map((w) => w.legacyId).sort()).toEqual(['thd_abc', 'thd_xyz'])
	})

	it('returns prj_* ids unchanged and emits no warning', () => {
		const { emitted, sink } = collectingSink()
		const result = acceptLegacyContainerId('prj_keepme', sink)
		expect(result).toBe('prj_keepme' as ProjectId)
		expect(emitted).toHaveLength(0)
	})

	it('rejects unknown prefixes with StalePrefixError', () => {
		const { sink } = collectingSink()
		expect(() => acceptLegacyContainerId('xyz_nope', sink)).toThrowError(StalePrefixError)
	})

	it('rejects a live top_* Topic id as an unknown prefix, not a legacy one (NZ-TOPIC-04)', () => {
		// The whole point of the narrowing: a Topic id must never be silently
		// coerced into a ProjectId, and it must fail with `unknown_prefix`
		// (a genuine "I don't recognize this"), not `thd_rejected` (which
		// would misreport it as a stale legacy container).
		const { sink } = collectingSink()
		try {
			acceptLegacyContainerId('top_abc', sink)
			expect.fail('expected throw')
		} catch (err) {
			expect(err).toBeInstanceOf(StalePrefixError)
			expect((err as StalePrefixError).details.kind).toBe('unknown_prefix')
		}
	})

	it('StalePrefixError carries structured details for unknown prefixes', () => {
		const { sink } = collectingSink()
		try {
			acceptLegacyContainerId('xyz_nope', sink)
			expect.fail('expected throw')
		} catch (err) {
			expect(err).toBeInstanceOf(StalePrefixError)
			expect((err as StalePrefixError).details.rawId).toBe('xyz_nope')
			expect((err as StalePrefixError).details.kind).toBe('unknown_prefix')
		}
	})

	it('NOOP_MIGRATION_WARNING_SINK swallows warnings without error', () => {
		expect(() => acceptLegacyContainerId('thd_noop', NOOP_MIGRATION_WARNING_SINK)).not.toThrow()
	})

	it('windowOpen: false rejects a thd_* input that windowOpen: true (the default) would coerce', () => {
		// The parameter, not the module const: this is the CLOSED branch the
		// acceptance criteria require to be reachable without touching
		// WINDOW_OPEN itself.
		const { emitted, sink } = collectingSink()
		try {
			acceptLegacyContainerId('thd_closed', sink, false)
			expect.fail('expected throw with the window explicitly closed')
		} catch (err) {
			expect(err).toBeInstanceOf(StalePrefixError)
			expect((err as StalePrefixError).details.kind).toBe('thd_rejected')
		}
		expect(emitted).toHaveLength(0)

		// Same input, window left at its default (open) — coerces as usual.
		const result = acceptLegacyContainerId('thd_closed', sink)
		expect(result).toBe('prj_closed' as ProjectId)
	})

	it('windowOpen: true behaves identically to the default (WINDOW_OPEN)', () => {
		const { sink: sinkA } = collectingSink()
		const { sink: sinkB } = collectingSink()
		expect(acceptLegacyContainerId('thd_same', sinkA, true)).toBe(
			acceptLegacyContainerId('thd_same', sinkB),
		)
	})
})

describe('rejectLegacyContainerPrefix', () => {
	it('throws StalePrefixError for thd_* input', () => {
		expect(() => rejectLegacyContainerPrefix('thd_abc')).toThrowError(StalePrefixError)
	})

	it('accepts prj_* input without throwing', () => {
		expect(() => rejectLegacyContainerPrefix('prj_abc')).not.toThrow()
	})

	it('accepts a live top_* Topic id without throwing (NZ-TOPIC-04) — it is not a legacy container id', () => {
		expect(() => rejectLegacyContainerPrefix('top_abc')).not.toThrow()
	})

	it('accepts non-legacy prefixes without throwing (writer guard is scoped to thd_*)', () => {
		expect(() => rejectLegacyContainerPrefix('ses_abc')).not.toThrow()
		expect(() => rejectLegacyContainerPrefix('run_abc')).not.toThrow()
	})
})
