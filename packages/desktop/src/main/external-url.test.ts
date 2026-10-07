import { expect, it } from 'vitest'
import { externalSourceUrl } from './external-url.js'

it('opens HTTP(S) sources and preserves URL data', () => {
	expect(externalSourceUrl('https://example.org/a?q=%20#section')).toBe(
		'https://example.org/a?q=%20#section',
	)
	expect(externalSourceUrl('http://example.org')).toBe('http://example.org/')
})

it.each([
	'javascript:alert(1)',
	'file:///C:/data',
	'data:text/html,hello',
	'vscode://open',
	'https://user:password@example.org',
	'https://example.org/\nmore',
	'//example.org',
	'',
	{},
	`https://example.org/${'a'.repeat(8_192)}`,
])('refuses non-web protocols, credentials and malformed links (%s)', (value) => {
	expect(() => externalSourceUrl(value)).toThrow()
})
