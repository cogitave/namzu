import { resolveContextWindow } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { getZenModels } from '../models.js'

/**
 * A listed model whose window falls to the SDK's 128k guess is compacted early and the owner is
 * never told. Every id either shipped service lists must resolve from the catalogue's own window
 * or from the SDK table, never from the default.
 */
describe.each(['zen', 'go'] as const)(
	'every model the %s catalogue lists has a known window',
	(service) => {
		it('resolves none of them to the default', () => {
			const guessed = getZenModels(service)
				.map((m) => ({
					id: m.id,
					...resolveContextWindow(undefined, m.id, m.contextWindow),
				}))
				.filter((r) => r.source === 'default')
				.map((r) => r.id)
			expect(guessed).toEqual([])
		})
	},
)
