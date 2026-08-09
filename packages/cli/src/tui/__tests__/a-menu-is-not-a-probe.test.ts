/**
 * A credential check answers about the credential, not about a catalogue.
 *
 * `verifyCredential` used to ask `listModels` and read a successful list as a
 * passed check. Two drivers proved that wrong in different ways, and both
 * reported a deliberately invalid key as verified:
 *
 * - one caught a real `401` and returned its hardcoded catalogue, so the truth
 *   existed and was discarded;
 * - one has no fallback and is entirely honest about its menu — its listing
 *   endpoint simply does not authenticate, so ANY string returned the real
 *   catalogue.
 *
 * The second is why the fix is a separate, declared probe rather than a rule
 * about writing `listModels` more carefully: no amount of care in a menu makes
 * it a probe.
 *
 * These are unit tests over the classifier and the declaration rule. That the
 * shipped drivers reject a real bad key was measured separately, against live
 * 401s from each vendor, and cannot be asserted here without a network.
 */

import { describe, expect, it } from 'vitest'

import { isCredentialRejection } from '../agent.js'

describe('isCredentialRejection', () => {
	it('treats an explicit 401 or 403 as the server refusing the key', () => {
		expect(isCredentialRejection(Object.assign(new Error('nope'), { status: 401 }))).toBe(true)
		expect(isCredentialRejection(Object.assign(new Error('nope'), { status: 403 }))).toBe(true)
		expect(isCredentialRejection(Object.assign(new Error('nope'), { statusCode: 401 }))).toBe(true)
	})

	it('does not treat other statuses as a refusal', () => {
		// A 500 or a 429 says nothing about whether the key is good.
		expect(isCredentialRejection(Object.assign(new Error('boom'), { status: 500 }))).toBe(false)
		expect(isCredentialRejection(Object.assign(new Error('slow down'), { status: 429 }))).toBe(
			false,
		)
	})

	it('does not treat a transport failure as a bad key', () => {
		// The direction that matters most. Telling an operator on broken wifi to
		// rotate a working credential is a different lie, not a smaller one.
		expect(isCredentialRejection(new TypeError('fetch failed'))).toBe(false)
		expect(isCredentialRejection(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe(false)
		expect(isCredentialRejection(new Error('connect ETIMEDOUT'))).toBe(false)
	})

	it('reads the message only when no status is present', () => {
		// Drivers that surface a plain Error still have to be classifiable.
		expect(isCredentialRejection(new Error('401 authentication_error'))).toBe(true)
		expect(isCredentialRejection(new Error('Invalid API key'))).toBe(true)
		// And a status that IS present wins over a message that happens to
		// contain a number, so a 500 whose body quotes "401" is not a refusal.
		expect(
			isCredentialRejection(Object.assign(new Error('upstream said 401'), { status: 500 })),
		).toBe(false)
	})

	it('says nothing was learned when it cannot tell', () => {
		// The fail-safe direction: an unrecognised failure is unverifiable, not
		// rejected, because only one of those sends someone to rotate a key.
		expect(isCredentialRejection(new Error('something went wrong'))).toBe(false)
		expect(isCredentialRejection(null)).toBe(false)
		expect(isCredentialRejection(undefined)).toBe(false)
	})
})
