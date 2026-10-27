import { describe, expect, it } from 'vitest'

import { classifyProviderError } from '../errors.js'

const withCode = (code: string, message = 'connect failed') =>
	new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) })

describe('connection failures', () => {
	it.each([
		'ENOTFOUND',
		'EAI_AGAIN',
		'ECONNREFUSED',
		'ECONNRESET',
		'EPIPE',
		'ENETUNREACH',
		'ENETDOWN',
		'EHOSTUNREACH',
		'EHOSTDOWN',
		'ERR_PROXY_TUNNEL',
		'EPROTO',
		'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
		'UND_ERR_SOCKET',
	])('%s is a retryable network failure', (code) => {
		const classified = classifyProviderError(withCode(code), 'openai')
		expect(classified.code).toBe('network')
		expect(classified.retryable).toBe(true)
	})

	it.each(['ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT'])('%s is a retryable timeout', (code) => {
		const classified = classifyProviderError(withCode(code), 'openai')
		expect(classified.code).toBe('timeout')
		expect(classified.retryable).toBe(true)
	})

	it.each([
		'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		'CERT_HAS_EXPIRED',
		'SELF_SIGNED_CERT_IN_CHAIN',
		'DEPTH_ZERO_SELF_SIGNED_CERT',
		'ERR_TLS_CERT_ALTNAME_INVALID',
	])('%s is a network failure that is not retried', (code) => {
		const classified = classifyProviderError(withCode(code), 'openai')
		expect(classified.code).toBe('network')
		expect(classified.retryable).toBe(false)
	})
})
