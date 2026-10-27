import { describe, expect, it } from 'vitest'
import { plainChildFailure } from '../failure-words.js'

describe('plainChildFailure', () => {
	it('replaces the host-contract refusal with plain words', () => {
		const text = plainChildFailure(
			"A cached message carries id 01a17fa4, which this session's log never recorded. A host must not mint its own id.",
		)
		expect(text).not.toContain('log')
		expect(text).not.toContain('01a17fa4')
		expect(text).toContain('Try the request again')
	})
	it('keeps any other message as the child said it', () => {
		expect(plainChildFailure('  Rate limited.\n')).toBe('Rate limited.')
	})
})
