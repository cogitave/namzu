import { describe, expect, it } from 'vitest'

import { classifyProviderError } from '../errors.js'

/**
 * Every signal was read off the error handed in, so one layer of wrapping
 * hid it — and wrapping is the normal case, not an edge one: a vendor SDK
 * wraps its transport error and the runtime wraps again on the way out.
 *
 * A rate limit wrapped ONCE classified as `unknown`, which is treated as
 * non-retryable. The retry policy was dead for every failure that was not
 * the outermost throwable, which is most of them.
 */

const wrap = (message: string, cause: unknown) => new Error(message, { cause })

describe('status through the chain', () => {
	// Deliberately mute: a message that says "too many requests" would let
	// the message-text fallback reach the same verdict, and the test would
	// pass with the status walk removed.
	const throttled = Object.assign(new Error('upstream returned an error'), { status: 429 })

	it('finds a rate limit one layer down', () => {
		const classified = classifyProviderError(wrap('request failed', throttled))
		expect(classified.code).toBe('rate_limit')
		expect(classified.retryable).toBe(true)
	})

	it('finds it three layers down', () => {
		const classified = classifyProviderError(
			wrap('run failed', wrap('step failed', wrap('request failed', throttled))),
		)
		expect(classified.code).toBe('rate_limit')
	})

	it('finds a status hidden in a metadata bag under a wrapper', () => {
		const aws = Object.assign(new Error('ThrottlingException'), {
			$metadata: { httpStatusCode: 429 },
		})
		expect(classifyProviderError(wrap('send failed', aws)).code).toBe('rate_limit')
	})

	it('still prefers the outermost status when two links carry one', () => {
		const inner = Object.assign(new Error('inner'), { status: 500 })
		const outer = Object.assign(wrap('outer', inner), { status: 429 })
		// The outer link is what the driver chose to expose; walking
		// outward-in keeps the un-wrapped case behaving exactly as before.
		expect(classifyProviderError(outer).status).toBe(429)
	})
})

describe('errno through the chain', () => {
	const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })

	it('finds a transport failure two layers down', () => {
		const classified = classifyProviderError(
			wrap('provider call failed', wrap('fetch failed', reset)),
		)
		// The one class of failure where retrying is almost always right.
		expect(classified.code).toBe('network')
		expect(classified.retryable).toBe(true)
	})

	it('finds a timeout errno under a wrapper', () => {
		const timedOut = Object.assign(new Error('headers timeout'), {
			code: 'UND_ERR_HEADERS_TIMEOUT',
		})
		expect(classifyProviderError(wrap('failed', timedOut)).code).toBe('timeout')
	})
})

describe('retry-after through the chain', () => {
	it('reads the header off the link that carries it', () => {
		const limited = Object.assign(new Error('rate limited'), {
			status: 429,
			headers: { 'retry-after': '30' },
		})
		expect(classifyProviderError(wrap('failed', limited)).retryAfterMs).toBe(30_000)
	})
})

describe('message through the chain', () => {
	it('reads a window overflow off an inner message', () => {
		const overflow = new Error('prompt is too long for this model')
		// A wrapper's message is usually generic, so matching only the outer
		// text looks at the one string least likely to say anything.
		expect(classifyProviderError(wrap('request failed', overflow)).code).toBe(
			'context_length_exceeded',
		)
	})

	it('lets a status anywhere on the chain beat message text', () => {
		const badRequest = Object.assign(new Error('bad request'), { status: 400 })
		const classified = classifyProviderError(wrap('the operation timed out', badRequest))
		// Status is the more reliable signal, wherever it sits; a wrapper
		// whose prose says "timed out" must not overrule it.
		expect(classified.code).toBe('invalid_request')
	})
})

describe('safety', () => {
	it('terminates on a cause cycle', () => {
		const a: { cause?: unknown; message: string } = { message: 'a' }
		const b = { message: 'b', cause: a }
		a.cause = b

		// Easy to build by accident when errors are re-wrapped in a retry
		// loop; without a seen-set the walk never returns.
		expect(classifyProviderError(a).code).toBe('unknown')
	})

	it('handles a chain that ends in a non-object', () => {
		expect(classifyProviderError(wrap('failed', 'a string cause')).code).toBe('unknown')
	})

	it('leaves an already-classified error alone', () => {
		const classified = classifyProviderError(Object.assign(new Error('x'), { status: 429 }))
		expect(classifyProviderError(wrap('outer', classified))).not.toBe(classified)
		expect(classifyProviderError(classified)).toBe(classified)
	})

	it('classifies an unwrapped error exactly as before', () => {
		for (const [err, code] of [
			[Object.assign(new Error('x'), { status: 401 }), 'auth'],
			[Object.assign(new Error('x'), { status: 404 }), 'not_found'],
			[Object.assign(new Error('x'), { status: 529 }), 'overloaded'],
			[new Error('nothing recognisable'), 'unknown'],
		] as const) {
			expect(classifyProviderError(err).code).toBe(code)
		}
	})
})
