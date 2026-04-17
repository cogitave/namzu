/**
 * Integration — ID-prefix read-accept + MigrationWarning emission.
 *
 * Covers roadmap §5 invariants: §13.3.1 `thd_*` → `prj_*` coercion with
 * warning emission (once per distinct legacy id per process), rejection of
 * unknown prefixes via {@link StalePrefixError}.
 *
 * Orthogonal to `session/migration/__tests__/id-prefix.test.ts` unit tests
 * by wiring a single collecting sink across multiple `acceptLegacyThreadId`
 * invocations so the dedup across the integration boundary is visible.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { ProjectId } from '../../../types/session/ids.js'
import {
	type MigrationWarning,
	type MigrationWarningSink,
	StalePrefixError,
	__resetSeenLegacyForTests,
	acceptLegacyThreadId,
} from '../../migration/id-prefix.js'

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

describe('Integration — ID-prefix migration window', () => {
	beforeEach(() => {
		__resetSeenLegacyForTests()
	})

	it('acceptLegacyThreadId("thd_abc") coerces to prj_abc and emits warning once', () => {
		const { emitted, sink } = collectingSink()
		const result = acceptLegacyThreadId('thd_abc', sink)

		expect(result).toBe('prj_abc' as ProjectId)
		expect(emitted).toHaveLength(1)
		expect(emitted[0]?.kind).toBe('id_prefix_legacy_read')
		expect(emitted[0]?.legacyId).toBe('thd_abc')
		expect(emitted[0]?.normalizedId).toBe('prj_abc')
		expect(emitted[0]?.emittedOncePerProcess).toBe(true)
	})

	it('second call with same id → no duplicate warning (process-level dedup)', () => {
		const { emitted, sink } = collectingSink()
		acceptLegacyThreadId('thd_abc', sink)
		acceptLegacyThreadId('thd_abc', sink)
		acceptLegacyThreadId('thd_abc', sink)
		expect(emitted).toHaveLength(1)
	})

	it('distinct legacy ids emit distinct warnings', () => {
		const { emitted, sink } = collectingSink()
		acceptLegacyThreadId('thd_abc', sink)
		acceptLegacyThreadId('thd_xyz', sink)
		acceptLegacyThreadId('thd_abc', sink) // dedup, no emission
		expect(emitted).toHaveLength(2)
		expect(emitted.map((w) => w.legacyId).sort()).toEqual(['thd_abc', 'thd_xyz'])
	})

	it('acceptLegacyThreadId("prj_abc") returns as-is with no warning', () => {
		const { emitted, sink } = collectingSink()
		const result = acceptLegacyThreadId('prj_abc', sink)
		expect(result).toBe('prj_abc' as ProjectId)
		expect(emitted).toHaveLength(0)
	})

	it('acceptLegacyThreadId("xyz_abc") rejects with StalePrefixError (unknown_prefix)', () => {
		const { sink } = collectingSink()
		try {
			acceptLegacyThreadId('xyz_abc', sink)
			expect.fail('expected StalePrefixError')
		} catch (err) {
			expect(err).toBeInstanceOf(StalePrefixError)
			expect((err as StalePrefixError).details.rawId).toBe('xyz_abc')
			expect((err as StalePrefixError).details.kind).toBe('unknown_prefix')
		}
	})

	it('dedup is per-sink-aggregated: a single process-level cache serves all sinks', () => {
		// The dedup state is process-global (seenLegacy Set inside id-prefix.ts),
		// so switching sinks mid-run does NOT re-trigger the warning. Consumers
		// wiring a shared collector across modules observe the single emission.
		const sinkA = collectingSink()
		const sinkB = collectingSink()

		acceptLegacyThreadId('thd_shared', sinkA.sink)
		expect(sinkA.emitted).toHaveLength(1)

		acceptLegacyThreadId('thd_shared', sinkB.sink)
		expect(sinkB.emitted).toHaveLength(0) // process-wide dedup
	})
})
