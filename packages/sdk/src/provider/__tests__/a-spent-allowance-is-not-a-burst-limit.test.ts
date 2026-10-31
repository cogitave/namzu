import { describe, expect, it } from 'vitest'

import { classifyProviderError } from '../../types/provider/errors.js'
import { ProviderRequestError, providerVendorError } from '../errors.js'

function vendorFailure(status: number, body: Record<string, unknown>, extra = {}): Error {
	return Object.assign(new Error(`${status} ${JSON.stringify(body)}`), { status, ...extra })
}

describe('a spent allowance reported as a throttle', () => {
	it('is a usage_limit when the driver carries a usage-limit code, and is not retried', () => {
		for (const providerCode of ['insufficient_quota', 'usage_limit_reached', 'billing_error']) {
			const err = new ProviderRequestError({
				kind: 'throttle',
				providerId: 'openai',
				status: 429,
				providerCode,
			})
			const classified = classifyProviderError(err)
			expect(classified.code, providerCode).toBe('usage_limit')
			expect(classified.retryable).toBe(false)
		}
	})

	it('reads the plan-limit type a subscription backend sends in `type` rather than `code`', () => {
		const vendor = vendorFailure(
			429,
			{ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } },
			{ type: 'usage_limit_reached' },
		)
		const wrapped = providerVendorError({ providerId: 'codex', error: vendor })
		expect(wrapped.kind).toBe('throttle')
		expect(wrapped.providerCode).toBe('usage_limit_reached')
		expect(classifyProviderError(wrapped).code).toBe('usage_limit')
	})

	it('reads the type nested one level down, as the Anthropic wire spells it', () => {
		const vendor = vendorFailure(
			402,
			{ type: 'error', error: { type: 'billing_error', message: 'Billing problem' } },
			{ error: { type: 'error', error: { type: 'billing_error', message: 'Billing problem' } } },
		)
		const wrapped = providerVendorError({ providerId: 'anthropic', error: vendor })
		expect(classifyProviderError(wrapped).code).toBe('usage_limit')
	})

	it('recognises an exhausted prepaid balance that arrives as an invalid request', () => {
		const vendor = vendorFailure(400, {
			type: 'error',
			error: {
				type: 'invalid_request_error',
				message: 'Your credit balance is too low to access the Anthropic API.',
			},
		})
		const wrapped = providerVendorError({ providerId: 'anthropic', error: vendor })
		expect(wrapped.kind).toBe('bad_request')
		const classified = classifyProviderError(wrapped)
		expect(classified.code).toBe('usage_limit')
		expect(classified.retryable).toBe(false)
	})

	it('leaves an ordinary burst limit retryable', () => {
		const vendor = vendorFailure(429, {
			type: 'error',
			error: {
				type: 'rate_limit_error',
				message: 'Number of requests has exceeded your rate limit',
			},
		})
		const classified = classifyProviderError(
			providerVendorError({ providerId: 'anthropic', error: vendor }),
		)
		expect(classified.code).toBe('rate_limit')
		expect(classified.retryable).toBe(true)
	})
})
