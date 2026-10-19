import { describe, expect, it } from 'vitest'

import { readOutputOverflow } from '../errors.js'

describe('readOutputOverflow', () => {
	const wording =
		'input length and `max_tokens` exceed context limit: 170000 + 20000 > 180000, decrease input length or `max_tokens` and try again'

	it('reads the three figures', () => {
		expect(readOutputOverflow(new Error(wording))).toEqual({
			inputTokens: 170_000,
			maxTokens: 20_000,
			contextLimit: 180_000,
		})
	})

	it('finds them on a wrapped cause', () => {
		const wrapped = new Error('request failed', { cause: new Error(wording) })
		expect(readOutputOverflow(wrapped)?.contextLimit).toBe(180_000)
	})

	it('ignores a prompt that is simply too long', () => {
		expect(
			readOutputOverflow(new Error('prompt is too long: 210000 tokens > 200000')),
		).toBeUndefined()
	})
})
