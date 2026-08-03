import { GENAI as CANONICAL_GENAI, NAMZU as CANONICAL_NAMZU } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { GENAI, NAMZU } from '../attributes.js'

/**
 * This subpath used to restate the attribute bags by hand, and had already
 * drifted — `GENAI.TOKEN_TYPE`, the dimension that splits the token counter
 * by kind, was missing from the published copy. Nothing caught it: this
 * package had no tests at all, and the public-surface verifier only loads
 * the SDK bundle.
 *
 * The re-export makes drift impossible by construction. This test exists so
 * that a future hand-copy — for a "small tweak", to break a dependency —
 * fails immediately rather than shipping and being noticed by a consumer.
 */

describe('attribute parity with the canonical bags', () => {
	it('is the same object, not a copy that can drift', () => {
		expect(GENAI).toBe(CANONICAL_GENAI)
		expect(NAMZU).toBe(CANONICAL_NAMZU)
	})

	it('carries every key the SDK defines', () => {
		expect(Object.keys(GENAI).sort()).toEqual(Object.keys(CANONICAL_GENAI).sort())
		expect(Object.keys(NAMZU).sort()).toEqual(Object.keys(CANONICAL_NAMZU).sort())
	})

	it('includes the key that was missing', () => {
		// Named explicitly: the identity assertion above would also pass on a
		// day when both bags were wrong in the same way.
		expect(GENAI.TOKEN_TYPE).toBe('gen_ai.token.type')
	})
})
