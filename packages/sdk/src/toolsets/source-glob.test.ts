import { describe, expect, it } from 'vitest'
import { matchesSourceIdGlob } from './source-glob.js'

describe('matchesSourceIdGlob', () => {
	it('matches an exact id with no wildcard', () => {
		expect(matchesSourceIdGlob('mcp:github', 'mcp:github')).toBe(true)
		expect(matchesSourceIdGlob('mcp:github', 'mcp:gitlab')).toBe(false)
	})

	it('matches a trailing-wildcard kind glob', () => {
		expect(matchesSourceIdGlob('mcp:github', 'mcp:*')).toBe(true)
		expect(matchesSourceIdGlob('plugin:acme', 'mcp:*')).toBe(false)
	})

	it('matches a hierarchical prefix across the id, including further ":" and "/" segments', () => {
		expect(matchesSourceIdGlob('plugin:acme/mcp:db', 'plugin:acme/*')).toBe(true)
		expect(matchesSourceIdGlob('plugin:acme', 'plugin:acme/*')).toBe(false)
	})

	it('escapes regex-special characters in the pattern\'s literal parts', () => {
		expect(matchesSourceIdGlob('plugin:a.b', 'plugin:a.b')).toBe(true)
		// A literal "." must not act as a regex wildcard.
		expect(matchesSourceIdGlob('plugin:aXb', 'plugin:a.b')).toBe(false)
	})

	it('a bare "*" matches every id', () => {
		expect(matchesSourceIdGlob('anything:at-all', '*')).toBe(true)
		expect(matchesSourceIdGlob('', '*')).toBe(true)
	})
})
