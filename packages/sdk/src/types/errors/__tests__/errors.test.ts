import { describe, expect, it } from 'vitest'

import { ProviderRequestError } from '../../../provider/errors.js'
import { ProviderError } from '../../provider/errors.js'
import { NamzuError, isNamzuError, toPlatformError } from '../index.js'

/**
 * `PlatformError` was declared and never constructed — a shape nothing
 * produced and nothing consumed — while the runtime threw bare `Error`
 * everywhere. A caller catching a failure from `query()` could not tell
 * "the model rate-limited us" from "the run was configured wrong" from
 * "that checkpoint does not exist". Matching on message text was the only
 * recourse, and message text is not an interface.
 */

describe('NamzuError', () => {
	it('is an Error, so code that only knows about Error still works', () => {
		const err = new NamzuError({ code: 'invalid_config', message: 'no model' })
		expect(err).toBeInstanceOf(Error)
		expect(err.message).toBe('no model')
		expect(err.stack).toBeDefined()
	})

	it('preserves the cause chain', () => {
		const root = new Error('ENOENT')
		const err = new NamzuError({ code: 'storage_error', message: 'write failed', cause: root })
		expect(err.cause).toBe(root)
	})

	it('defaults `retryable` per code, and lets a caller override it', () => {
		expect(new NamzuError({ code: 'invalid_config', message: 'x' }).retryable).toBe(false)
		expect(new NamzuError({ code: 'storage_error', message: 'x' }).retryable).toBe(true)
		expect(
			new NamzuError({ code: 'invalid_config', message: 'x', retryable: true }).retryable,
		).toBe(true)
	})

	it('narrows through `isNamzuError`', () => {
		expect(isNamzuError(new NamzuError({ code: 'unknown', message: 'x' }))).toBe(true)
		expect(isNamzuError(new Error('x'))).toBe(false)
		expect(isNamzuError('x')).toBe(false)
	})
})

describe('toPlatformError', () => {
	it('gives a host ONE shape regardless of what was thrown', () => {
		// Which is the entire point: without this, "handle errors from the
		// SDK" means writing the same instanceof ladder in every caller.
		for (const thrown of [
			new NamzuError({ code: 'plugin_error', message: 'a' }),
			new ProviderError({ code: 'rate_limit', message: 'b' }),
			new Error('c'),
			'not even an error',
		]) {
			const platform = toPlatformError(thrown)
			expect(typeof platform.code).toBe('string')
			expect(typeof platform.message).toBe('string')
			expect(typeof platform.retryable).toBe('boolean')
		}
	})

	it('carries a NamzuError through unchanged', () => {
		const err = new NamzuError({
			code: 'not_found',
			message: 'Checkpoint not found: cp_1',
			details: { checkpointId: 'cp_1' },
		})
		expect(toPlatformError(err)).toEqual({
			code: 'not_found',
			message: 'Checkpoint not found: cp_1',
			details: { checkpointId: 'cp_1' },
			retryable: false,
		})
	})

	it('keeps a ProviderError`s classification instead of recomputing it', () => {
		// The provider taxonomy already knows things this one does not —
		// which status codes back off, what the server asked for.
		const err = new ProviderError({
			code: 'rate_limit',
			message: 'slow down',
			providerId: 'anthropic',
			status: 429,
			retryAfterMs: 3_000,
		})

		expect(toPlatformError(err)).toEqual({
			code: 'provider_error',
			message: 'slow down',
			details: {
				providerCode: 'rate_limit',
				providerId: 'anthropic',
				status: 429,
				retryAfterMs: 3_000,
			},
			retryable: true,
		})
	})

	it('does not claim a non-retryable provider failure is retryable', () => {
		const err = new ProviderError({ code: 'auth', message: 'bad key' })
		expect(toPlatformError(err).retryable).toBe(false)
	})

	it('projects the current driver error shape through the same provider taxonomy', () => {
		const err = new ProviderRequestError({
			kind: 'throttle',
			providerId: 'openai',
			providerCode: 'rate_limit_exceeded',
			status: 429,
			retryAfterMs: 8_000,
			detail: 'organization window exhausted',
		})

		expect(toPlatformError(err)).toEqual({
			code: 'provider_error',
			message: err.message,
			details: {
				providerCode: 'rate_limit',
				providerId: 'openai',
				status: 429,
				retryAfterMs: 8_000,
			},
			retryable: true,
		})
	})

	it('reports a plain Error honestly as `unknown` rather than guessing', () => {
		expect(toPlatformError(new Error('something broke'))).toEqual({
			code: 'unknown',
			message: 'something broke',
			retryable: false,
		})
	})

	it('does not lose a thrown non-Error', () => {
		// Rare, and usually a bug elsewhere — but dropping it is worse than
		// reporting it as-is.
		expect(toPlatformError({ weird: true }).message).toBe('[object Object]')
		expect(toPlatformError(undefined).message).toBe('undefined')
	})
})
