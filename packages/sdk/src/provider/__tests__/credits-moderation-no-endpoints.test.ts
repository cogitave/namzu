import { describe, expect, it } from 'vitest'
import { classifyProviderError } from '../../types/provider/errors.js'
import { classifyProviderHttpStatus, providerHttpError } from '../errors.js'

const MODERATION = JSON.stringify({ error: { message: 'Input flagged by moderation', code: 403 } })
const NO_ENDPOINTS = JSON.stringify({
	error: { message: 'No endpoints found for x/y.', code: 404 },
})

describe('402, 403 and 404 kinds', () => {
	it('classifies each status by status and body', () => {
		expect(classifyProviderHttpStatus(402)).toBe('credits')
		expect(classifyProviderHttpStatus(403, MODERATION)).toBe('moderation')
		expect(classifyProviderHttpStatus(403, '{"error":{"message":"forbidden"}}')).toBe('auth')
		expect(classifyProviderHttpStatus(403)).toBe('auth')
		expect(classifyProviderHttpStatus(401, MODERATION)).toBe('auth')
		expect(classifyProviderHttpStatus(404, NO_ENDPOINTS)).toBe('no_endpoints')
		expect(classifyProviderHttpStatus(404, '{"error":{"message":"nope"}}')).toBe('bad_request')
	})

	it.each([
		[402, undefined, 'credits', 'usage_limit'],
		[403, MODERATION, 'moderation', 'content_filter'],
		[404, NO_ENDPOINTS, 'no_endpoints', 'not_found'],
	] as const)('status %i is never retried and keeps its kind', (status, body, kind, code) => {
		const err = providerHttpError({ providerId: 'openrouter', status, body })
		expect(err.kind).toBe(kind)
		const classified = classifyProviderError(err)
		expect(classified.code).toBe(code)
		expect(classified.retryable).toBe(false)
	})
})
