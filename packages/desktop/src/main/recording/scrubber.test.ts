import { describe, expect, it } from 'vitest'
import { REMOVED, looksLikeSecretToken, scrub } from './scrubber.js'

describe('the scrubber', () => {
	it.each([
		'sk-abcdefghijklmnop',
		'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
		'xoxb-123456789012-abcdef',
		'github_pat_11ABCDEFG0abcdefghijklmnop',
		'AKIAIOSFODNN7EXAMPLE',
	])('replaces the known prefix %s', (token) => {
		expect(scrub(`use ${token} now`)).toEqual({ text: `use ${REMOVED} now`, redacted: 1 })
	})

	it('replaces a long high-entropy token', () => {
		expect(scrub('a8F3kL0pQz9XvB2nM7cT4wY6uJ1hG5dS').text).toBe(REMOVED)
	})

	it('leaves ordinary words, long words and paths alone', () => {
		for (const text of [
			'overdue invoices for the third quarter',
			'internationalization',
			'C:\\Users\\someone\\Documents\\report.xlsx',
			'https://example.com/a/b',
		])
			expect(scrub(text)).toEqual({ text, redacted: 0 })
	})

	it('removes a key block from its header on', () => {
		const out = scrub('here -----BEGIN PRIVATE KEY----- MIIEvQIBADANBg')
		expect(out.text).toBe(`here ${REMOVED}`)
		expect(out.redacted).toBe(1)
	})

	it('replaces a card number that passes the Luhn check and not one that fails it', () => {
		expect(scrub('card 4111 1111 1111 1111 ok').text).toBe(`card ${REMOVED} ok`)
		expect(scrub('order 4111 1111 1111 1112 ok').text).toBe('order 4111 1111 1111 1112 ok')
	})

	it('is not fooled by punctuation around a token', () => {
		expect(looksLikeSecretToken('(sk-abcdefghijkl),')).toBe(true)
	})
})
