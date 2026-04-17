import { beforeEach, describe, expect, it } from 'vitest'
import type { ProjectId } from '../../../types/session/ids.js'
import {
	NOOP_MIGRATION_WARNING_SINK,
	StalePrefixError,
	__resetSeenLegacyForTests,
	acceptLegacyThreadId,
	rejectLegacyPrefix,
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

describe('acceptLegacyThreadId', () => {
	beforeEach(() => {
		__resetSeenLegacyForTests()
	})

	it('coerces thd_* to prj_* and emits a warning on first encounter', () => {
		const { emitted, sink } = collectingSink()
		const result = acceptLegacyThreadId('thd_abc', sink)
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
		acceptLegacyThreadId('thd_abc', sink)
		acceptLegacyThreadId('thd_abc', sink)
		acceptLegacyThreadId('thd_abc', sink)
		expect(emitted).toHaveLength(1)
	})

	it('emits distinct warnings for distinct legacy ids', () => {
		const { emitted, sink } = collectingSink()
		acceptLegacyThreadId('thd_abc', sink)
		acceptLegacyThreadId('thd_xyz', sink)
		expect(emitted).toHaveLength(2)
		expect(emitted.map((w) => w.legacyId).sort()).toEqual(['thd_abc', 'thd_xyz'])
	})

	it('returns prj_* ids unchanged and emits no warning', () => {
		const { emitted, sink } = collectingSink()
		const result = acceptLegacyThreadId('prj_keepme', sink)
		expect(result).toBe('prj_keepme' as ProjectId)
		expect(emitted).toHaveLength(0)
	})

	it('rejects unknown prefixes with StalePrefixError', () => {
		const { sink } = collectingSink()
		expect(() => acceptLegacyThreadId('xyz_nope', sink)).toThrowError(StalePrefixError)
	})

	it('StalePrefixError carries structured details for unknown prefixes', () => {
		const { sink } = collectingSink()
		try {
			acceptLegacyThreadId('xyz_nope', sink)
			expect.fail('expected throw')
		} catch (err) {
			expect(err).toBeInstanceOf(StalePrefixError)
			expect((err as StalePrefixError).details.rawId).toBe('xyz_nope')
			expect((err as StalePrefixError).details.kind).toBe('unknown_prefix')
		}
	})

	it('NOOP_MIGRATION_WARNING_SINK swallows warnings without error', () => {
		expect(() => acceptLegacyThreadId('thd_noop', NOOP_MIGRATION_WARNING_SINK)).not.toThrow()
	})
})

describe('rejectLegacyPrefix', () => {
	it('throws StalePrefixError for thd_* input', () => {
		expect(() => rejectLegacyPrefix('thd_abc')).toThrowError(StalePrefixError)
	})

	it('accepts prj_* input without throwing', () => {
		expect(() => rejectLegacyPrefix('prj_abc')).not.toThrow()
	})

	it('accepts non-thread prefixes without throwing (writer guard is scoped)', () => {
		// The guard is specifically for thd_* re-emission; unrelated prefixes
		// are a concern for their own parse functions.
		expect(() => rejectLegacyPrefix('ses_abc')).not.toThrow()
		expect(() => rejectLegacyPrefix('run_abc')).not.toThrow()
	})
})
