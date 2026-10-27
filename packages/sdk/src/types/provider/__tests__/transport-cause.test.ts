import { describe, expect, it } from 'vitest'

import { providerVendorError } from '../../../provider/errors.js'
import { explainError } from '../../errors/catalog.js'
import { classifyProviderError, readTransportCause } from '../errors.js'

/**
 * A request can fail on the way to the provider rather than at it: a proxy that
 * wants a sign-in or refuses the tunnel, or a certificate nobody here trusts.
 * None of these carries an HTTP status or a socket error code, so they used to
 * file as an unknown failure with no advice, and a retry met the same proxy or
 * the same certificate again.
 */

const wrap = (message: string, cause: unknown) => new Error(message, { cause })
// The sentence undici writes when a tunnel request is answered with another status.
const tunnel = (status: number) =>
	Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), {
		code: 'UND_ERR_ABORTED',
	})
const certificate = (code: string) => Object.assign(new Error('certificate problem'), { code })

describe('readTransportCause', () => {
	it('reads a proxy that wants a sign-in, however deep it sits', () => {
		const failure = wrap('Connection error.', wrap('fetch failed', tunnel(407)))
		expect(readTransportCause(failure)).toBe('proxy_auth_required')
	})

	it('reads any other proxy refusal', () => {
		expect(readTransportCause(wrap('fetch failed', tunnel(403)))).toBe('proxy_refused')
		expect(readTransportCause(wrap('fetch failed', tunnel(502)))).toBe('proxy_refused')
	})

	it.each([
		'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		'SELF_SIGNED_CERT_IN_CHAIN',
		'DEPTH_ZERO_SELF_SIGNED_CERT',
		'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	])('reads an untrusted certificate from %s', (code) => {
		expect(readTransportCause(wrap('fetch failed', certificate(code)))).toBe(
			'untrusted_certificate',
		)
	})

	it('says nothing about a failure that is not about the path', () => {
		expect(readTransportCause(wrap('fetch failed', certificate('ECONNRESET')))).toBeUndefined()
		expect(readTransportCause(new Error('Proxy response mentioned in passing'))).toBeUndefined()
		expect(readTransportCause('text')).toBeUndefined()
	})
})

describe('classifyProviderError for the network path', () => {
	it.each([
		['a proxy sign-in', wrap('Connection error.', wrap('fetch failed', tunnel(407)))],
		['a proxy refusal', wrap('Connection error.', wrap('fetch failed', tunnel(403)))],
		[
			'an untrusted certificate',
			wrap('Connection error.', certificate('UNABLE_TO_VERIFY_LEAF_SIGNATURE')),
		],
	])('files %s as a network failure that is not worth retrying', (_name, failure) => {
		const classified = classifyProviderError(failure, 'anthropic')
		expect(classified.code).toBe('network')
		expect(classified.retryable).toBe(false)
	})

	it('leaves an ordinary dropped connection retryable', () => {
		const dropped = wrap(
			'Connection error.',
			Object.assign(new Error('read'), { code: 'ECONNRESET' }),
		)
		expect(classifyProviderError(dropped).retryable).toBe(true)
	})
})

describe('explaining the network path', () => {
	it.each([
		[
			'provider.proxy_auth',
			wrap('Connection error.', tunnel(407)),
			/asked for a sign-in/,
			/user:password/,
		],
		[
			'provider.proxy_refused',
			wrap('Connection error.', tunnel(403)),
			/refused to pass/,
			/NO_PROXY/,
		],
		[
			'provider.untrusted_certificate',
			wrap('Connection error.', certificate('SELF_SIGNED_CERT_IN_CHAIN')),
			/certificate is not trusted/,
			/NODE_EXTRA_CA_CERTS/,
		],
	])('%s', (id, failure, message, hint) => {
		const explained = explainError(classifyProviderError(failure, 'openai'))
		expect(explained?.id).toBe(id)
		expect(explained?.message).toMatch(message)
		expect(explained?.hint).toMatch(hint)
	})

	it('keeps the general advice for a provider that simply cannot be reached', () => {
		const dropped = wrap(
			'Connection error.',
			Object.assign(new Error('read'), { code: 'ECONNRESET' }),
		)
		expect(explainError(classifyProviderError(dropped))?.id).toBe('provider.network')
	})
})

describe('a driver’s own error keeps the diagnosis', () => {
	// Drivers never attach the vendor error as a cause, so the diagnosis rides on
	// the error they throw.
	it('marks a vendor failure caused by a refusing proxy as a network failure that must not be resent', () => {
		const vendor = wrap('Connection error.', wrap('fetch failed', tunnel(407)))
		const thrown = providerVendorError({ providerId: 'openai', error: vendor })
		expect(thrown).toMatchObject({
			kind: 'network',
			transport: 'proxy_auth_required',
			shouldRetry: false,
		})
		expect(thrown.cause).toBeUndefined()
		const classified = classifyProviderError(thrown, 'openai')
		expect(classified.code).toBe('network')
		expect(classified.retryable).toBe(false)
		expect(explainError(classified)?.id).toBe('provider.proxy_auth')
		expect(explainError(thrown)?.id).toBe('provider.proxy_auth')
	})

	it('does the same for an untrusted certificate', () => {
		const vendor = wrap('Connection error.', certificate('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))
		const thrown = providerVendorError({ providerId: 'anthropic', error: vendor })
		expect(thrown).toMatchObject({ kind: 'network', transport: 'untrusted_certificate' })
		expect(explainError(thrown)?.id).toBe('provider.untrusted_certificate')
	})

	it('leaves a dropped connection retryable and without a diagnosis', () => {
		const vendor = wrap(
			'Connection error.',
			Object.assign(new Error('read'), { code: 'ECONNRESET' }),
		)
		const thrown = providerVendorError({ providerId: 'openai', error: vendor })
		expect(thrown.transport).toBeUndefined()
		expect(thrown.shouldRetry).toBeUndefined()
		expect(classifyProviderError(thrown).retryable).toBe(true)
	})
})
