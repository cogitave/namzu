import { describe, expect, it } from 'vitest'

import { claudeVersionAtLeast, parseClaudeModelVersion } from '../claude-model-version.js'

/**
 * The defect this module exists to end: the minor-version group was `\d+`, so
 * it swallowed the 8-digit date suffix. Measured against the shipped pattern,
 * `claude-sonnet-4-20250514` parsed as minor **20250514** — which made a dated
 * id naming no minor compare as enormously newer than one that does, and
 * inverted every capability gate keyed on `minor >= n`.
 *
 * Three copies of that regex existed: this capability table and two drivers.
 * The dated-no-minor row below is the one none of their tests had.
 */

describe('a date suffix is not a minor version', () => {
	it.each([
		['claude-sonnet-4-20250514', 'sonnet', 4, 0],
		['claude-opus-4-20250514', 'opus', 4, 0],
		['claude-haiku-3-20240307', 'haiku', 3, 0],
	])('%s parses as %s %d.%d', (model, family, major, minor) => {
		expect(parseClaudeModelVersion(model)).toEqual({ family, major, minor })
	})

	it('still reads a real minor that is followed by a date', () => {
		expect(parseClaudeModelVersion('claude-opus-4-1-20250805')).toEqual({
			family: 'opus',
			major: 4,
			minor: 1,
		})
		expect(parseClaudeModelVersion('claude-sonnet-4-5-20250929')).toEqual({
			family: 'sonnet',
			major: 4,
			minor: 5,
		})
	})

	it('treats a missing minor as .0 rather than as absent', () => {
		expect(parseClaudeModelVersion('claude-opus-5')).toEqual({
			family: 'opus',
			major: 5,
			minor: 0,
		})
	})

	it('tolerates a vendor prefix and the other separators', () => {
		expect(parseClaudeModelVersion('anthropic/claude-opus-4-5')?.minor).toBe(5)
		expect(parseClaudeModelVersion('claude-opus-4.5')?.minor).toBe(5)
		expect(parseClaudeModelVersion('CLAUDE-OPUS-4-5')?.major).toBe(4)
	})

	it('returns undefined for what it does not recognise', () => {
		for (const id of ['gpt-4o', 'claude', 'claude-opus', 'llama-3-70b', '']) {
			expect(parseClaudeModelVersion(id)).toBeUndefined()
		}
	})
})

describe('claudeVersionAtLeast', () => {
	it('does not let a dated id clear a gate it is below', () => {
		// The whole point. With the old regex this was `true`, because
		// 4.20250514 >= 4.5.
		expect(claudeVersionAtLeast('claude-sonnet-4-20250514', 4, 5)).toBe(false)
		expect(claudeVersionAtLeast('claude-opus-4-20250514', 4, 7)).toBe(false)
	})

	it('admits versions that genuinely clear it', () => {
		expect(claudeVersionAtLeast('claude-sonnet-4-5-20250929', 4, 5)).toBe(true)
		expect(claudeVersionAtLeast('claude-opus-5', 4, 7)).toBe(true)
		expect(claudeVersionAtLeast('claude-opus-4-1', 4, 5)).toBe(false)
	})

	it('refuses a name it cannot parse rather than opening the gate', () => {
		// Fail-safe: a capability gate must not open for an id it does not
		// understand.
		expect(claudeVersionAtLeast('some-other-model', 4, 5)).toBe(false)
	})
})
