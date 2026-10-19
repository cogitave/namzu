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
			providerCode: 'server_busy',
		})
		expect(isProviderRequestError(classified)).toBe(true)
		expect(classified.providerCode).toBe('server_busy')

		const impostor = Object.assign(new Error('not classified'), {
			name: 'ProviderRequestError',
			kind: 'anything',
		})
		expect(isProviderRequestError(impostor)).toBe(false)
	})

	it('does not accept an arbitrary provider code through a direct or structural error', () => {
		const secret = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'
		const direct = new ProviderRequestError({
			kind: 'bad_request',
			providerId: 'test-provider',
			providerCode: secret,
		})
		const structural = Object.assign(new Error('not safe'), {
			name: 'ProviderRequestError',
			kind: 'bad_request',
			providerId: 'test-provider',
			providerCode: secret,
		})

		expect(direct.providerCode).toBeUndefined()
		expect(isProviderRequestError(structural)).toBe(false)
	})
})

describe('the reference terminal context-overflow wordings', () => {
	const wordings = [
		['prompt is too long', 'prompt is too long: 213000 tokens > 200000 maximum'],
		['input is too long for requested model', 'Input is too long for requested model.'],
		['context window', 'The request is larger than the model context window of 8192 tokens'],
		[
			'input length and max_tokens exceed context limit',
			'input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000',
		],
	] as const

	it.each(wordings)('files "%s" as a context overflow on a 400', (_name, body) => {
		expect(bodySaysContextOverflow(body)).toBe(true)
		expect(classifyProviderHttpStatus(400, body)).toBe('context_overflow')
		expect(classifyProviderHttpStatus(413, body)).toBe('context_overflow')
	})

	it.each([
		'does not support the temperature parameter with the 1M context window beta',
		'context window information unavailable',
		'too many requests for long context window usage',
		'key not enabled for the extended context window',
		'context window cache miss',
	])('does not file "%s" as an overflow', (body) => {
		expect(bodySaysContextOverflow(body)).toBe(false)
		expect(classifyProviderHttpStatus(400, body)).toBe('bad_request')
	})

	it.each([
		'larger than the model context window of 8192 tokens',
		'the prompt exceeds the context window',
		'maximum context window is 128000 tokens',
		'your input is too long for the context window',
	])('files "%s" as an overflow', (body) => {
		expect(bodySaysContextOverflow(body)).toBe(true)
	})

	it('leaves a throttle that mentions the window as a throttle', () => {
		expect(classifyProviderHttpStatus(429, 'rate limited; context window usage is high')).toBe(
			'throttle',
		)
	})
})
