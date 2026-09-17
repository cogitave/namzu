import { describe, expect, it } from 'vitest'

import { assertNotPubliclyAddressed } from '../index.js'

/**
 * With no subnet the platform assigns a public address, and the group is then
 * reachable by anything that can route to it. Inside a private network the
 * network was the boundary doing the work; on a public address there is no
 * boundary left.
 *
 * The worker now requires a per-instance bearer token and refuses a routable
 * bind without one, and THIS backend still has no credential to give it. The
 * one override the claim API admits — a config map — is a file mount rather
 * than an environment variable, and this worker reads its token from
 * `process.env` at startup, so a per-claim value would land somewhere nothing
 * reads; Microsoft's own guidance is that config map values are not validated
 * by the runtime and are not where a value affecting application security
 * belongs. The refusal below is about which way the address default falls and
 * is unchanged — it now stands in front of a worker that would refuse the
 * public case itself. See `docs/sdk/container-sandbox-worker.md`.
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
		// it is refused is what is exposed by it, and that is the sentence that
		// changes an operator's mind. It used to say the worker "has no
		// authentication of any kind", which stopped being true when the token
		// landed: the exposure now is a control API reachable from the
		// internet behind nothing better than plain HTTP.
		expect(() => assertNotPubliclyAddressed({})).toThrow(/plain HTTP/i)
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
