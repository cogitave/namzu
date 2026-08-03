import { describe, expect, it } from 'vitest'

import {
	ProviderRequestError,
	bodySaysContextOverflow,
	classifyProviderHttpStatus,
	isCallerAbortError,
	isProviderRequestError,
	parseRetryAfterMs,
	providerVendorError,
} from '../errors.js'

describe('provider error taxonomy', () => {
	it('classifies only context-specific limit messages as context overflow', () => {
		expect(bodySaysContextOverflow('input token count exceeds the maximum for this model')).toBe(
			true,
		)
		expect(bodySaysContextOverflow('tool count exceeds the maximum allowed')).toBe(false)
		expect(bodySaysContextOverflow('reduce the tool list length')).toBe(false)
	})

	it('does not treat a generic HTTP 413 as model context overflow', () => {
		expect(classifyProviderHttpStatus(413, 'request body too large at reverse proxy')).toBe(
			'bad_request',
		)
		expect(classifyProviderHttpStatus(413, 'prompt is too long for requested model')).toBe(
			'context_overflow',
		)
	})

	it('parses both Retry-After forms and rejects stale or invalid values', () => {
		expect(parseRetryAfterMs('2', 0)).toBe(2000)
		expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000)).toBe(4000)
		expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:01 GMT', 1000)).toBeUndefined()
		expect(parseRetryAfterMs('later', 0)).toBeUndefined()
	})

	it('drops the vendor object and its non-enumerable cause entirely', () => {
		const secret = 'sk-FAKE-DO-NOT-LOG'
		const vendor = new Error(`invalid api key ${secret}`, {
			cause: new Error(`response body ${secret}`),
		})
		Object.assign(vendor, { status: 401 })

		const classified = providerVendorError({
			providerId: 'test-provider',
			error: vendor,
		})

		expect(classified).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'auth',
			status: 401,
			providerId: 'test-provider',
		})
		expect(classified.message).not.toContain(secret)
		expect('cause' in classified).toBe(false)
	})

	it('recognizes a caller abort only when that signal actually aborted', () => {
		const controller = new AbortController()
		const sdkAbort = Object.assign(new Error('request aborted'), {
			name: 'APIUserAbortError',
		})

		expect(isCallerAbortError(sdkAbort, controller.signal)).toBe(false)
		controller.abort(new Error('user stopped'))
		expect(isCallerAbortError(sdkAbort, controller.signal)).toBe(true)
		expect(isCallerAbortError(controller.signal.reason, controller.signal)).toBe(true)
	})

	it('requires the complete structural contract when SDK copies differ', () => {
		const classified = new ProviderRequestError({
			kind: 'server',
			providerId: 'test-provider',
		})
		expect(isProviderRequestError(classified)).toBe(true)

		const impostor = Object.assign(new Error('not classified'), {
			name: 'ProviderRequestError',
			kind: 'anything',
		})
		expect(isProviderRequestError(impostor)).toBe(false)
	})
})
