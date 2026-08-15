import { describe, expect, it } from 'vitest'
import { generateTopicId } from '../../../utils/id.js'
import {
	NOOP_MIGRATION_WARNING_SINK,
	StalePrefixError,
	acceptLegacyContainerId,
	rejectLegacyContainerPrefix,
} from '../id-prefix.js'

/**
 * D2 (ses_020): `thd_` meant two unrelated things — the pre-0.2.0 top-level
 * container this module coerces, and the live Topic layer `generateTopicId`
 * minted. NZ-TOPIC-04 disambiguates by narrowing the latter to `top_`, so a
 * freshly-minted topic id is no longer legacy input by construction.
 *
 * Written against the pre-NZ-TOPIC-04 tree, both `it` blocks below fail:
 * with `generateTopicId` still minting `thd_`, `rejectLegacyContainerPrefix`
 * (then named `rejectLegacyPrefix`) throws on every minted id instead of
 * accepting it, and `acceptLegacyContainerId` (then `acceptLegacyThreadId`)
 * silently coerces it to a `prj_`-prefixed string typed `ProjectId` instead
 * of refusing it. That pair is exactly the bug D2 names, and this file is
 * its discharge. Falsified by regressing `generateTopicId` back to `thd_`.
 */
describe('an id the SDK mints is not legacy', () => {
	it('rejectLegacyContainerPrefix does not throw on 200 freshly-minted topic ids', () => {
		// 200 draws: the generator is random over [0-9a-z], and one sample
		// proves nothing about the alphabet it can reach.
		for (let i = 0; i < 200; i++) {
			const id = generateTopicId()
			expect(() => rejectLegacyContainerPrefix(id)).not.toThrow()
		}
	})

	it('acceptLegacyContainerId throws StalePrefixError(unknown_prefix) on 200 freshly-minted topic ids, never returning a value', () => {
		for (let i = 0; i < 200; i++) {
			const id = generateTopicId()
			try {
				acceptLegacyContainerId(id, NOOP_MIGRATION_WARNING_SINK)
				expect.fail(`expected ${id} to be rejected as an unknown prefix, not silently accepted`)
			} catch (err) {
				expect(err).toBeInstanceOf(StalePrefixError)
				expect((err as StalePrefixError).details.kind).toBe('unknown_prefix')
			}
		}
	})

	/**
	 * `windowOpen` is an explicit parameter on `acceptLegacyContainerId`, not
	 * a read of the module-level `WINDOW_OPEN` const, specifically so its
	 * CLOSED branch is reachable from a test without mutating shared module
	 * state (a-check-that-cannot-fail applied to a cutover switch).
	 *
	 * `rejectLegacyContainerPrefix` deliberately does NOT take a `windowOpen`
	 * parameter — established against the actual current source, not against
	 * the task text that first asked for one on both functions: the writer
	 * guard's behaviour (reject `thd_*` emission) is invariant to migration-
	 * window state in both rows of the module header's own OPEN/CLOSED table
	 * ("Writer emits: prj_* only" either way). A `windowOpen` parameter with
	 * no behavioural effect would itself be `declared-but-undriven`. Its
	 * outcome on a minted `top_*` id is therefore identical across window
	 * states by construction, already covered by the first `it` above.
	 */
	it('acceptLegacyContainerId gives the same outcome for a minted id whether the window is explicitly open or explicitly closed', () => {
		const id = generateTopicId()
		expect(() => acceptLegacyContainerId(id, NOOP_MIGRATION_WARNING_SINK, true)).toThrow(
			StalePrefixError,
		)
		expect(() => acceptLegacyContainerId(id, NOOP_MIGRATION_WARNING_SINK, false)).toThrow(
			StalePrefixError,
		)
	})
})
