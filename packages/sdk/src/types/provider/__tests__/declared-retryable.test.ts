import { describe, expect, it } from 'vitest'

import { ProviderError, classifyProviderError, declaredRetryable } from '../errors.js'

/**
 * Retryability was derived solely from namzu's own code set, so a vendor
 * SDK that says outright "this one is safe to retry" was not listened to.
 * That set is a second-hand inference from status and wording, and it
 * necessarily lags every new failure shape a provider invents — a failure
 * nobody has characterised yet lands on `unknown`, which is treated as
 * non-retryable, even when its own author flagged it retryable.
 *
 * The classification still decides WHAT went wrong. Only the retry verdict
 * defers to a first-hand statement.
 */

describe('a retryable flag declared upstream', () => {
	it('is read off the error itself', () => {
		const err = Object.assign(new Error('something new'), { retryable: true })
		expect(classifyProviderError(err).retryable).toBe(true)
	})

	it('is read off a wrapped cause', () => {
		// Wrapping is the normal case, not an edge one: vendor SDKs wrap
		// their transport errors and the runtime wraps again on the way out.
		const inner = Object.assign(new Error('inner'), { retryable: true })
		const outer = new Error('request failed', { cause: inner })
		expect(classifyProviderError(outer).retryable).toBe(true)
	})

	it('can also say a failure is NOT retryable', () => {
		// A 503 that the provider knows is permanent for this request.
		const err = Object.assign(new Error('permanently unavailable'), {
			status: 503,
			retryable: false,
		})
		const classified = classifyProviderError(err)

		expect(classified.code).toBe('overloaded')
		// The code still says what it is; only the verdict changed.
		expect(classified.retryable).toBe(false)
	})

	it('does not change the classification, only the verdict', () => {
		const err = Object.assign(new Error('bad request'), { status: 400, retryable: true })
		const classified = classifyProviderError(err)

		expect(classified.code).toBe('invalid_request')
		expect(classified.retryable).toBe(true)
	})

	it('takes the outermost declaration when links disagree', () => {
		// The outer layer made the more recent statement, knowing what the
		// inner one said.
		const inner = Object.assign(new Error('inner'), { retryable: true })
		const outer = Object.assign(new Error('outer'), { retryable: false, cause: inner })
		expect(declaredRetryable(outer)).toBe(false)
	})

	it('leaves the code in charge when nothing declared anything', () => {
		expect(declaredRetryable(new Error('plain'))).toBeUndefined()
		expect(classifyProviderError(Object.assign(new Error('x'), { status: 429 })).retryable).toBe(
			true,
		)
		expect(classifyProviderError(Object.assign(new Error('x'), { status: 401 })).retryable).toBe(
			false,
		)
	})

	it('ignores a non-boolean flag rather than coercing it', () => {
		// `retryable: 'yes'` is a foreign object's field, not a contract.
		// Coercing it would let any truthy value silently enable retries.
		expect(declaredRetryable({ retryable: 'yes' })).toBeUndefined()
		expect(declaredRetryable({ retryable: 1 })).toBeUndefined()
	})

	it('is honoured when a ProviderError is constructed directly', () => {
		const err = new ProviderError({
			code: 'invalid_request',
			message: 'x',
			retryable: true,
		})
		expect(err.retryable).toBe(true)
	})
})
