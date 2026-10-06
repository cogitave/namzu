import { describe, expect, it } from 'vitest'

import { parseStructuredResultJson } from './structured-result-json.js'

describe('retained structured-result JSON', () => {
	it.each([
		{ text: 'null', expected: null },
		{ text: '"ready"', expected: 'ready' },
		{ text: 'false', expected: false },
		{ text: '12.5', expected: 12.5 },
		{ text: '[null,"ready",{"score":2}]', expected: [null, 'ready', { score: 2 }] },
		{ text: '{"score":2}', expected: { score: 2 } },
	])('accepts the literal JSON value $text', ({ text, expected }) => {
		expect(parseStructuredResultJson(text)).toEqual(expected)
	})

	it.each([null, undefined, false, 2, {}, ['null'], Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects non-string evidence %j without coercion',
		(value) => {
			expect(() => parseStructuredResultJson(value)).toThrow(/JSON text/)
		},
	)

	it.each(['NaN', 'Infinity', '1e400', '-1e400', '-0', '{"score":-0}', '[1e400]', 'undefined'])(
		'rejects non-durable numeric or invalid JSON text %s',
		(text) => {
			expect(() => parseStructuredResultJson(text)).toThrow()
		},
	)

	it('preserves a literal __proto__ data key without changing object prototypes', () => {
		const parsed = parseStructuredResultJson(
			'{"__proto__":{"durableMarkerPolluted":true},"nested":{"__proto__":"data"}}',
		) as Record<string, unknown>
		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
		expect(Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value).toEqual({
			durableMarkerPolluted: true,
		})
		expect(Object.getPrototypeOf(parsed.nested)).toBe(Object.prototype)
		expect(Object.getOwnPropertyDescriptor(parsed.nested, '__proto__')?.value).toBe('data')
		expect(Object.prototype).not.toHaveProperty('durableMarkerPolluted')
	})
})
