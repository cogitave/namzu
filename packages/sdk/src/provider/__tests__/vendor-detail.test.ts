import { describe, expect, it } from 'vitest'

import { providerHttpError, providerVendorError, redactSecrets, vendorDetail } from '../errors.js'

/**
 * The provider's own account of what was wrong, kept — and scrubbed.
 *
 * `ProviderRequestErrorInit` declared `detail` from the beginning and the
 * constructor never read it, so the field existed and carried nothing. The
 * body was read to classify and then dropped, deliberately, because an error
 * body can echo a request and a request can carry a key.
 *
 * The cost of that trade showed up in production: the wire had been saying
 * `tools.0.custom.input_schema: … must match JSON Schema draft 2020-12` and
 * the SDK deleted the sentence, so diagnosing it took seven eliminated
 * hypotheses and a day of downtime. Keeping the sentence and scrubbing the
 * credential shapes is the trade that was actually available.
 */

describe('the sentence that names the broken field survives', () => {
	it('preserves a bounded provider code independently of changing prose', () => {
		const flat = providerHttpError({
			providerId: 'image-provider',
			status: 400,
			body: JSON.stringify({
				code: 'invalid_image',
				error: 'some future wording without the legacy phrase',
			}),
		})
		const sdkError = Object.assign(new Error('another future wording'), {
			status: 400,
			code: 'invalid_image',
		})

		expect(flat.providerCode).toBe('invalid_image')
		expect(
			providerVendorError({ providerId: 'image-provider', error: sdkError }).providerCode,
		).toBe('invalid_image')
	})

	it('does not turn an arbitrary response field into provider-code metadata', () => {
		for (const code of ['secret value with spaces', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv']) {
			const err = providerHttpError({
				providerId: 'image-provider',
				status: 400,
				body: JSON.stringify({ code, error: 'invalid request' }),
			})
			expect(err.providerCode).toBeUndefined()
		}
	})

	it('lifts the structured message out of a vendor body', () => {
		const body = JSON.stringify({
			type: 'error',
			error: {
				type: 'invalid_request_error',
				message:
					'tools.0.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12',
			},
		})

		expect(vendorDetail(body)).toBe(
			'tools.0.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12',
		)
	})

	it('reaches the error a caller actually catches', () => {
		const err = providerHttpError({
			providerId: 'anthropic',
			status: 400,
			body: JSON.stringify({ error: { message: "Schema type 'oneOf' is not supported" } }),
		})

		expect(err.detail).toContain('oneOf')
		// …and the message too, so a log line that prints only the message is
		// still enough to act on.
		expect(err.message).toContain('oneOf')
	})

	it('falls back to the raw text when the body is not JSON', () => {
		expect(vendorDetail('upstream connect error, transport failure')).toBe(
			'upstream connect error, transport failure',
		)
	})

	it('says nothing rather than something empty', () => {
		expect(vendorDetail(undefined)).toBeUndefined()
		expect(vendorDetail(null)).toBeUndefined()
		expect(vendorDetail('   ')).toBeUndefined()
		expect(vendorDetail({})).toBeUndefined()
	})

	it('truncates a body that is not a sentence', () => {
		const detail = vendorDetail('x'.repeat(5_000))
		expect(detail?.length).toBeLessThanOrEqual(401)
		expect(detail?.endsWith('…')).toBe(true)
	})
})

describe('a credential never rides along', () => {
	it.each([
		['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 'anthropic-style key'],
		['npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345', 'npm token'],
		['ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345', 'github token'],
		['AKIAIOSFODNN7EXAMPLE', 'aws access key id'],
	])('scrubs %s (%s)', (secret) => {
		const scrubbed = redactSecrets(`upstream rejected token ${secret} for this request`)
		expect(scrubbed).not.toContain(secret)
		// The marker changed from a bare '[redacted]' to a labelled
		// '[REDACTED:<label>]' when this table moved to the shared union —
		// see constants/secret-patterns.ts. The label itself is asserted by
		// that module's own test suite; this one only needs to know a match
		// happened.
		expect(scrubbed).toContain('[REDACTED:')
	})

	it('scrubs a bearer header the vendor echoed back', () => {
		const scrubbed = redactSecrets('bad header: Authorization: Bearer abcdef0123456789ABCDEF')
		expect(scrubbed).not.toContain('abcdef0123456789ABCDEF')
	})

	it('scrubs a credential-named JSON field without eating the rest', () => {
		const scrubbed = redactSecrets('{"api_key":"sk-live-9999","model":"the-model-that-failed"}')
		expect(scrubbed).not.toContain('sk-live-9999')
		// The surrounding sentence is the whole point — scrubbing must not
		// degrade into deleting the message.
		expect(scrubbed).toContain('the-model-that-failed')
	})

	it('scrubs on the real path, not only in the helper', () => {
		const err = providerHttpError({
			providerId: 'anthropic',
			status: 401,
			body: JSON.stringify({
				error: { message: 'invalid key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv supplied' },
			}),
		})

		expect(err.detail).not.toContain('AbCdEfGhIjKlMnOpQrStUv')
		expect(err.detail).toContain('[REDACTED:')
		expect(err.message).not.toContain('AbCdEfGhIjKlMnOpQrStUv')
	})
})

describe('the provider type, code and request ID travel beside its sentence', () => {
	const openai403 = () =>
		Object.assign(new Error('403 Your project does not have access to model gpt-6-luna'), {
			name: 'PermissionDeniedError',
			status: 403,
			type: 'invalid_request_error',
			code: 'model_not_found',
			param: null,
			requestID: 'req_9f8e7d',
		})

	it('reads them off the vendor SDK error fields', () => {
		const err = providerVendorError({ providerId: 'openai', error: openai403() })
		expect(JSON.parse(err.detail ?? '')).toEqual({
			error: {
				message: 'Your project does not have access to model gpt-6-luna',
				type: 'invalid_request_error',
				code: 'model_not_found',
			},
			request_id: 'req_9f8e7d',
		})
		expect(err.providerCode).toBe('model_not_found')
	})

	it('falls back to the x-request-id response header', () => {
		const vendor = Object.assign(openai403(), {
			requestID: undefined,
			headers: new Headers({ 'x-request-id': 'req_from_header' }),
		})
		const err = providerVendorError({ providerId: 'openai', error: vendor })
		expect(JSON.parse(err.detail ?? '').request_id).toBe('req_from_header')
	})

	it('leaves a message that already carries its body, and a bare sentence, as they were', () => {
		const anthropic = Object.assign(
			new Error('403 {"type":"error","error":{"type":"permission_error","message":"nope"}}'),
			{ status: 403, type: 'permission_error' },
		)
		expect(providerVendorError({ providerId: 'anthropic', error: anthropic }).detail).toContain(
			'permission_error',
		)
		const bare = Object.assign(new Error('boom'), { status: 500 })
		expect(providerVendorError({ providerId: 'x', error: bare }).detail).toBe('boom')
	})

	it('never lets a credential-shaped field value ride along', () => {
		const vendor = Object.assign(openai403(), { requestID: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv' })
		const err = providerVendorError({ providerId: 'openai', error: vendor })
		expect(err.detail).not.toContain('sk-ant')
	})

	it('keeps the status of a Google body as the type, and the response request ID', () => {
		const err = providerHttpError({
			providerId: 'google',
			status: 403,
			requestId: 'goog_req_1',
			body: JSON.stringify({
				error: { code: 403, message: 'Denied for this project', status: 'PERMISSION_DENIED' },
			}),
		})
		expect(JSON.parse(err.detail ?? '')).toEqual({
			error: { message: 'Denied for this project', type: 'PERMISSION_DENIED' },
			request_id: 'goog_req_1',
		})
	})
})
