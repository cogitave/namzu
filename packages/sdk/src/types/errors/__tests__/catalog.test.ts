import { describe, expect, it } from 'vitest'

import { ProviderRequestError } from '../../../provider/errors.js'
import { ProviderError } from '../../provider/errors.js'
import { DEFAULT_ERROR_RULES, explainError, factsOf, readHint, withHint } from '../catalog.js'
import { NamzuError } from '../index.js'

/**
 * A failure surfaced as whatever prose the vendor SDK happened to write:
 * no stable id to grep in logs, no instruction on what to change, and no
 * growth point — a newly-observed failure shape could only be given
 * curated copy by editing the classifier itself.
 *
 * Classification and remediation are separate jobs. The first is
 * structural and belongs at the boundary; the second is editorial and
 * belongs in a list a human appends to. `DoctorCheckResult` already
 * carried `message` and `remediation` as separate fields — `namzu doctor`
 * was simply the only surface that got either.
 */

const providerError = (code: string, status?: number) =>
	new ProviderError({
		code: code as never,
		message: 'the vendor wrote this',
		providerId: 'test',
		...(status !== undefined ? { status } : {}),
	})

describe('explaining a failure', () => {
	it('gives a stale key an id and something to do about it', () => {
		const explanation = explainError(providerError('auth', 401))

		expect(explanation?.id).toBe('provider.auth')
		expect(explanation?.hint).toMatch(/API key/)
		// Not the vendor's sentence: the point is copy an operator can act
		// on, keyed by an id they can grep for.
		expect(explanation?.message).not.toContain('the vendor wrote this')
	})

	it('separates a permission failure from an authentication one', () => {
		// The provider codes collapse 401 and 403, but the two call for
		// different actions and the status still tells them apart.
		expect(explainError(providerError('auth', 403))?.id).toBe('provider.permission')
		expect(explainError(providerError('auth', 401))?.id).toBe('provider.auth')
	})

	it('recognises the failures an operator hits first', () => {
		expect(explainError(providerError('rate_limit', 429))?.id).toBe('provider.rate_limit')
		expect(explainError(providerError('context_length_exceeded'))?.id).toBe(
			'provider.context_overflow',
		)
		expect(explainError(providerError('overloaded', 529))?.id).toBe('provider.unavailable')
		expect(explainError(providerError('network'))?.id).toBe('provider.network')
		expect(explainError(providerError('not_found', 404))?.id).toBe('provider.model_not_found')
	})

	it('recognises the current driver throttle shape without matching its prose', () => {
		const err = new ProviderRequestError({
			kind: 'throttle',
			providerId: 'openai',
			status: 429,
			retryAfterMs: 4_000,
			detail: 'future vendor wording',
		})
		expect(factsOf(err)).toMatchObject({ code: 'rate_limit', status: 429, retryAfterMs: 4_000 })
		expect(explainError(err)?.id).toBe('provider.rate_limit')
	})

	it('says nothing rather than inventing advice', () => {
		// A generic fallback would send the reader somewhere specific and
		// wrong, which is worse than admitting the failure is unfamiliar.
		expect(explainError(new Error('something nobody has characterised'))).toBeNull()
	})

	it('matches on structure, not on vendor prose', () => {
		// Vendor copy changes without warning and differs per SDK version,
		// so a rule keyed to it silently stops matching.
		const reworded = providerError('rate_limit', 429)
		Object.defineProperty(reworded, 'message', { value: 'completely different wording' })
		expect(explainError(reworded)?.id).toBe('provider.rate_limit')
	})

	it('takes the first matching rule, so a rule can be as specific as it likes', () => {
		const ids = DEFAULT_ERROR_RULES.map((rule) => rule.id)
		expect(ids.indexOf('provider.permission')).toBeLessThan(ids.indexOf('provider.auth'))
	})
})

describe('a hint attached where the failure was raised', () => {
	it('wins over a rule matched on a status code', () => {
		// Code that raised the failure knows more about it than a generic
		// rule ever will — a container that has not been built, a daemon
		// that is not running.
		const err = withHint(providerError('rate_limit', 429), 'the sandbox worker is not running')
		const explanation = explainError(err)

		expect(explanation?.id).toBe('hint.from_throw_site')
		expect(explanation?.hint).toBe('the sandbox worker is not running')
	})

	it('survives being read back off a plain throwable', () => {
		expect(readHint(withHint(new Error('boom'), 'check the socket path'))).toBe(
			'check the socket path',
		)
	})

	it('does not change the message or the type', () => {
		// Baking remediation into the message is what made it impossible to
		// separate again — a surface could not render one without the other.
		const original = new NamzuError({ code: 'storage_error', message: 'write failed' })
		const hinted = withHint(original, 'the run directory is not writable')

		expect(hinted).toBe(original)
		expect(hinted.message).toBe('write failed')
		expect(hinted instanceof NamzuError).toBe(true)
	})

	it('is not enumerable, so it cannot leak into a serialized error', () => {
		const err = withHint(new Error('boom'), 'a hint')
		expect(Object.keys(err)).not.toContain('hint')
	})

	it('ignores an empty or non-string hint', () => {
		expect(readHint(withHint(new Error('boom'), ''))).toBeUndefined()
		expect(readHint({ hint: 42 })).toBeUndefined()
		expect(readHint(null)).toBeUndefined()
	})
})

describe('the facts a rule matches on', () => {
	it('reads a provider classification', () => {
		const facts = factsOf(providerError('rate_limit', 429))
		expect(facts).toMatchObject({ code: 'rate_limit', status: 429 })
	})

	it('reads a namzu code', () => {
		expect(factsOf(new NamzuError({ code: 'tool_error', message: 'x' })).code).toBe('tool_error')
	})

	it('still produces facts for something that was never an Error', () => {
		expect(factsOf('just a string').message).toBe('just a string')
	})
})
