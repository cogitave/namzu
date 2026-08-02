import { describe, expect, it } from 'vitest'

import { classifyProviderError } from '../errors.js'

/**
 * Overflow is the one 4xx the runtime can act on: it sheds history and
 * retries. Everything else in the 400 family is surfaced. So the rescue is
 * gated on the code being EXACTLY `context_length_exceeded`, and anything
 * that misses that gate dies holding the remedy.
 *
 * Detection was a substring search over five phrases. The structural code —
 * the one field a provider has for saying what went wrong — was extracted
 * from the cause chain and then fed only to the two transport-errno sets,
 * so a provider that said `context_length_exceeded` in so many words was
 * answered with a phrase search that did not match.
 */

const overflowReaches = (err: unknown) =>
	classifyProviderError(err).code === 'context_length_exceeded'

describe('the structural code', () => {
	it('is believed over the status that carries it', () => {
		// A 400 is a category; the code is the diagnosis.
		expect(
			overflowReaches(
				Object.assign(new Error('Bad request'), { status: 400, code: 'context_length_exceeded' }),
			),
		).toBe(true)
	})

	it('is read from a gateway body discriminator too', () => {
		expect(
			overflowReaches(
				Object.assign(new Error('Bad request'), { status: 400, type: 'context_length_exceeded' }),
			),
		).toBe(true)
	})

	it('is read from a nested error envelope', () => {
		expect(
			overflowReaches(
				Object.assign(new Error('Bad request'), {
					status: 400,
					error: { type: 'context_window_exceeded' },
				}),
			),
		).toBe(true)
	})

	it('is found under a wrapper', () => {
		const inner = Object.assign(new Error('Bad request'), { code: 'max_tokens_exceeded' })
		expect(overflowReaches(new Error('request failed', { cause: inner }))).toBe(true)
	})

	it('classifies a rate limit from the code alone', () => {
		const classified = classifyProviderError(
			Object.assign(new Error('Bad request'), { status: 400, code: 'rate_limit_exceeded' }),
		)
		expect(classified.code).toBe('rate_limit')
		expect(classified.retryable).toBe(true)
	})

	it('leaves a code it does not recognise to the other signals', () => {
		const classified = classifyProviderError(
			Object.assign(new Error('nope'), { status: 404, code: 'some_vendor_specific_thing' }),
		)
		expect(classified.code).toBe('not_found')
	})
})

describe('wordings that used to miss', () => {
	it.each([
		'Input is too long for requested model.',
		'This request exceeds the maximum length for this model',
		'The input is too large for the context window',
		'payload too large for the selected model',
	])('%s', (message) => {
		expect(overflowReaches(Object.assign(new Error(message), { status: 400 }))).toBe(true)
	})

	it('still recognises the wordings that already worked', () => {
		for (const message of [
			'prompt is too long',
			'maximum context length exceeded',
			'too many tokens in request',
		]) {
			expect(overflowReaches(Object.assign(new Error(message), { status: 400 }))).toBe(true)
		}
	})

	it('does not fire on an ordinary bad request', () => {
		const classified = classifyProviderError(
			Object.assign(new Error('The model id is not valid'), { status: 400 }),
		)
		// Overreaching here would send a run into compaction it cannot be
		// rescued by, and hide the real error behind a retry.
		expect(classified.code).toBe('invalid_request')
	})
})

describe('an already-classified error', () => {
	it('is not re-examined, which is why a driver must not guess', () => {
		// The classifier short-circuits on a typed error. That is correct —
		// a driver knows its own vendor best — but it means a driver that
		// pre-files a name whose meaning depends on the body makes the body
		// unreadable.
		const preFiled = classifyProviderError(
			Object.assign(new Error('Input is too long for requested model.'), { status: 400 }),
		)
		expect(preFiled.code).toBe('context_length_exceeded')
		expect(classifyProviderError(preFiled)).toBe(preFiled)
	})
})
