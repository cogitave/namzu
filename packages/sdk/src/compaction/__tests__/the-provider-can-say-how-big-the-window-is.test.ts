import { describe, expect, it } from 'vitest'

import { DEFAULT_ASSUMED_CONTEXT_WINDOW, resolveContextWindow } from '../context-window.js'

/**
 * The window a compaction measures against had one hand-maintained table
 * under it.
 *
 * That table's own header records the incident: one vendor family's
 * entries all carried 200k including the models whose window is 1M, so
 * those runs compacted at roughly 14% full and threw away the prompt-cache
 * prefix to do it. Every model release drifts it again until somebody
 * edits it — and at least one driver
 * was already parsing the vendor's real `context_length` and discarding
 * it, because there was no member to return it through.
 *
 * Every case here asserts `source` as well as `tokens`. A right number
 * reached by the wrong route is the failure that made the table's own
 * incident invisible for as long as it was: nothing said where 200k came
 * from.
 */

describe('where the context window comes from', () => {
	it('lets an explicit config beat a provider answer', () => {
		// A host that set a number said what they want, and no discovery
		// outranks that. Otherwise a driver could quietly override an
		// operator who had capped the window deliberately.
		const resolved = resolveContextWindow(50_000, 'claude-sonnet-4-6', 1_000_000)

		expect(resolved).toEqual({ tokens: 50_000, source: 'config' })
	})

	it('lets a provider answer beat the table', () => {
		// The whole point. The table is a guess maintained by hand; the
		// vendor's own number is not.
		const resolved = resolveContextWindow(undefined, 'claude-sonnet-4-6', 1_000_000)

		expect(resolved).toEqual({ tokens: 1_000_000, source: 'provider' })
	})

	it('falls through to the TABLE when the provider does not know', () => {
		// Not to the default. "I asked and it does not know" leaves the table
		// exactly as authoritative as it was before anyone asked — dropping
		// to `DEFAULT_ASSUMED_CONTEXT_WINDOW` would make asking actively
		// worse than not asking.
		const withProvider = resolveContextWindow(undefined, 'claude-sonnet-4-6', undefined)
		const withoutProvider = resolveContextWindow(undefined, 'claude-sonnet-4-6')

		expect(withProvider).toEqual(withoutProvider)
		expect(withProvider.source).toBe('model-table')
		expect(withProvider.tokens).not.toBe(DEFAULT_ASSUMED_CONTEXT_WINDOW)
	})

	it('behaves exactly as before when nothing reports one', () => {
		const resolved = resolveContextWindow(undefined, 'some-model-nobody-has-tabled')

		expect(resolved).toEqual({
			tokens: DEFAULT_ASSUMED_CONTEXT_WINDOW,
			source: 'default',
		})
	})

	it('ignores a nonsense provider answer rather than trusting it', () => {
		// Zero and negative are not windows. A driver that returns one has a
		// bug, and running a compaction trigger against a window of 0 divides
		// every measurement into infinity — which reads as "always compact".
		for (const nonsense of [0, -1]) {
			expect(resolveContextWindow(undefined, 'claude-sonnet-4-6', nonsense).source).toBe(
				'model-table',
			)
		}
	})
})
