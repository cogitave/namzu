import { describe, expect, it } from 'vitest'

import { assertNotPubliclyAddressed } from '../index.js'

/**
 * With no subnet the platform assigns a public address, and the worker
 * answering on it has no authentication of any kind — its own docblock
 * says "Authn: none". Inside a private network that is the boundary doing
 * the work; on a public address there is no boundary left.
 *
 * The defect was not that a public address is possible. It is that it was
 * reachable by *omission* — a caller who had never heard of `subnetId` got
 * one with no signal at all. These tests are about which way the default
 * falls, not about whether the option exists.
 */

describe('claiming a container group with no subnet', () => {
	it('refuses, rather than quietly taking a public address', () => {
		expect(() => assertNotPubliclyAddressed({})).toThrow(/will not claim/i)
	})

	it('names both ways out, because a refusal a reader cannot act on is a dead end', () => {
		// The operator who hits this has two legitimate destinations — a
		// private network, or an explicit acceptance for a benchmark — and a
		// message naming neither sends them to read the source.
		expect(() => assertNotPubliclyAddressed({})).toThrow(/subnetId/)
		expect(() => assertNotPubliclyAddressed({})).toThrow(/allowPublicAddress/)
	})

	it('says what is on the address, not just that it is public', () => {
		// "Public address" alone reads as a networking preference. The reason
		// it is refused is that the thing answering there is unauthenticated,
		// and that is the sentence that changes an operator's mind.
		expect(() => assertNotPubliclyAddressed({})).toThrow(/no authentication/i)
	})
})

describe('the two ways to proceed', () => {
	it('accepts a subnet, which is the production answer', () => {
		expect(() =>
			assertNotPubliclyAddressed({ subnetId: '/subscriptions/x/subnets/private' }),
		).not.toThrow()
	})

	it('accepts an explicit acceptance of a public address', () => {
		expect(() => assertNotPubliclyAddressed({ allowPublicAddress: true })).not.toThrow()
	})

	it('does not treat a falsy opt-in as an opt-in', () => {
		// `allowPublicAddress: false` is a caller who considered it and said
		// no. Reading it as "unset, therefore ask again" would be harmless;
		// reading it as truthy would be the hole reopened, so pin it.
		expect(() => assertNotPubliclyAddressed({ allowPublicAddress: false })).toThrow()
	})

	it('does not treat an empty subnet id as a subnet', () => {
		// An empty string is what a missing environment variable interpolates
		// to, and it is the shape most likely to arrive from a config file
		// rather than from a person.
		expect(() => assertNotPubliclyAddressed({ subnetId: '' })).toThrow()
	})
})
