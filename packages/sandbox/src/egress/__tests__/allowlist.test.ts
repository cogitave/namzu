import { describe, expect, it } from 'vitest'

import { isHostAllowed, splitAuthority } from '../allowlist.js'

/**
 * The part that decides whether untrusted code reaches the network.
 *
 * Substring matching is the obvious implementation and it is a hole: an
 * entry of `example.com` would admit `example.com.attacker.net`, a domain
 * the attacker owns. Plain suffix matching has the same hole without a
 * leading dot — `notexample.com` ends with `example.com`.
 */

describe('an exact host entry', () => {
	it('matches only that host', () => {
		expect(isHostAllowed('api.example.com', ['api.example.com'])).toBe(true)
		expect(isHostAllowed('other.example.com', ['api.example.com'])).toBe(false)
	})

	it('does not match a host that merely contains it', () => {
		// The whole reason this is not `includes`.
		expect(isHostAllowed('api.example.com.attacker.net', ['api.example.com'])).toBe(false)
	})

	it('does not match a prefix of itself', () => {
		expect(isHostAllowed('example.com', ['api.example.com'])).toBe(false)
	})
})

describe('a wildcard entry', () => {
	it('matches subdomains', () => {
		expect(isHostAllowed('api.example.com', ['.example.com'])).toBe(true)
		expect(isHostAllowed('deep.api.example.com', ['.example.com'])).toBe(true)
	})

	it('matches the apex too', () => {
		// An author writing the wildcard form means the site; admitting
		// `www.example.com` but not `example.com` reads as a bug.
		expect(isHostAllowed('example.com', ['.example.com'])).toBe(true)
	})

	it('does not match a domain that merely ends with the same letters', () => {
		// This is why the leading dot is required rather than optional.
		expect(isHostAllowed('notexample.com', ['.example.com'])).toBe(false)
		expect(isHostAllowed('evilexample.com', ['.example.com'])).toBe(false)
	})

	it('does not match a domain that only contains it', () => {
		expect(isHostAllowed('example.com.attacker.net', ['.example.com'])).toBe(false)
	})
})

describe('normalisation', () => {
	it('ignores case, because DNS does', () => {
		expect(isHostAllowed('API.Example.COM', ['api.example.com'])).toBe(true)
	})

	it('ignores a trailing dot, which is the same name', () => {
		// An allowlist that treats `example.com.` as different is bypassable
		// by typing the host differently.
		expect(isHostAllowed('example.com.', ['example.com'])).toBe(true)
	})

	it('ignores surrounding whitespace in an entry', () => {
		expect(isHostAllowed('example.com', ['  example.com  '])).toBe(true)
	})
})

describe('an empty allowlist', () => {
	it('denies everything', () => {
		expect(isHostAllowed('example.com', [])).toBe(false)
	})

	it('is not satisfied by an empty entry', () => {
		// `''` must not become a wildcard through some string coincidence.
		expect(isHostAllowed('example.com', ['', '   '])).toBe(false)
	})

	it('denies an empty host', () => {
		expect(isHostAllowed('', ['example.com'])).toBe(false)
	})
})

describe('splitting an authority', () => {
	it('separates host from port', () => {
		expect(splitAuthority('example.com:8443')).toEqual({ host: 'example.com', port: 8443 })
	})

	it('leaves a bare host alone', () => {
		expect(splitAuthority('example.com')).toEqual({ host: 'example.com' })
	})

	it('handles a bracketed IPv6 literal', () => {
		// A `split(':')` would shred this, and the allowlist would then be
		// matching against a fragment.
		expect(splitAuthority('[::1]:9000')).toEqual({ host: '::1', port: 9000 })
		expect(splitAuthority('[2001:db8::1]')).toEqual({ host: '2001:db8::1' })
	})

	it('keeps the whole value when the port is not a number', () => {
		expect(splitAuthority('example.com:notaport')).toEqual({ host: 'example.com:notaport' })
	})
})
