import { describe, expect, it } from 'vitest'

import { modelVersionAtLeast, parseVersionedModelId } from '../model-version.js'
import type { ModelIdGrammar } from '../model-version.js'

/**
 * The defect this module exists to end: the minor-version group was `\d+`, so
 * it swallowed the 8-digit release date. An id naming no minor therefore
 * parsed as `major.<the date>` and compared as enormously NEWER than one that
 * does, inverting every capability gate keyed on `minor >= n` — a model was
 * told it supported features it does not.
 *
 * Three drivers had each written the same matcher, and all three had it. The
 * vocabulary below is deliberately invented: the shape is what lives here, and
 * a test that needed real product names would be testing the wrong layer.
 */

const GRAMMAR: ModelIdGrammar = {
	product: 'widget',
	families: ['small', 'large'],
	routingPrefix: 'vendor/',
}

describe('a date suffix is not a minor version', () => {
	it.each([
		['widget-small-4-20250514', 'small', 4, 0],
		['widget-large-4-20250514', 'large', 4, 0],
		['widget-small-3-20240307', 'small', 3, 0],
	])('%s parses as %s %d.%d', (id, family, major, minor) => {
		expect(parseVersionedModelId(id, GRAMMAR)).toEqual({ family, major, minor })
	})

	it('still reads a real minor that is followed by a date', () => {
		expect(parseVersionedModelId('widget-large-4-1-20250805', GRAMMAR)).toEqual({
			family: 'large',
			major: 4,
			minor: 1,
		})
		expect(parseVersionedModelId('widget-small-4-5-20250929', GRAMMAR)?.minor).toBe(5)
	})

	it('treats a missing minor as .0 rather than as absent', () => {
		expect(parseVersionedModelId('widget-large-5', GRAMMAR)).toEqual({
			family: 'large',
			major: 5,
			minor: 0,
		})
	})

	it('tolerates the routing prefix, the other separators, and case', () => {
		expect(parseVersionedModelId('vendor/widget-large-4-5', GRAMMAR)?.minor).toBe(5)
		expect(parseVersionedModelId('widget-large-4.5', GRAMMAR)?.minor).toBe(5)
		expect(parseVersionedModelId('WIDGET-LARGE-4-5', GRAMMAR)?.major).toBe(4)
	})

	it('returns undefined for what the grammar does not describe', () => {
		for (const id of ['other-large-4', 'widget', 'widget-large', 'widget-medium-4', '']) {
			expect(parseVersionedModelId(id, GRAMMAR)).toBeUndefined()
		}
	})

	it('escapes regex metacharacters in the grammar', () => {
		// A product or prefix containing `.` or `+` must match literally, not
		// as a wildcard. `.map(escape)` — the global, deprecated one — would
		// percent-encode instead, and pass every other test in this file
		// because no ordinary name contains a character it changes.
		const odd: ModelIdGrammar = { product: 'a.b', families: ['c+d'] }

		expect(parseVersionedModelId('a.b-c+d-4', odd)?.major).toBe(4)
		expect(parseVersionedModelId('axb-cxd-4', odd)).toBeUndefined()
	})
})

describe('modelVersionAtLeast', () => {
	it('does not let a dated id clear a gate it is below', () => {
		// The whole point. With the old `\d+` minor this was `true`, because
		// 4.20250514 >= 4.5.
		expect(modelVersionAtLeast('widget-small-4-20250514', GRAMMAR, 4, 5)).toBe(false)
		expect(modelVersionAtLeast('widget-large-4-20250514', GRAMMAR, 4, 7)).toBe(false)
	})

	it('admits versions that genuinely clear it', () => {
		expect(modelVersionAtLeast('widget-small-4-5-20250929', GRAMMAR, 4, 5)).toBe(true)
		expect(modelVersionAtLeast('widget-large-5', GRAMMAR, 4, 7)).toBe(true)
		expect(modelVersionAtLeast('widget-large-4-1', GRAMMAR, 4, 5)).toBe(false)
	})

	it('refuses a name it cannot parse rather than opening the gate', () => {
		// Fail-safe: a capability gate must not open for an id it does not
		// understand.
		expect(modelVersionAtLeast('something-else', GRAMMAR, 4, 5)).toBe(false)
	})
})
