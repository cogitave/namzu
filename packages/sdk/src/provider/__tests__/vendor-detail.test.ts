import { describe, expect, it } from 'vitest'

import { providerHttpError, redactSecrets, vendorDetail } from '../errors.js'

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
		expect(scrubbed).toContain('[redacted]')
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
		expect(err.detail).toContain('[redacted]')
		expect(err.message).not.toContain('AbCdEfGhIjKlMnOpQrStUv')
	})
})
