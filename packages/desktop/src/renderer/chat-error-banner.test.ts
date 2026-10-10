import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatErrorBanner } from './chat-error-banner.js'

const RAW = [
	"Error invoking remote method 'namzu:providers': SupersededConversationSettingsError: The conversation settings changed while loading. Retry this request.",
	"Error invoking remote method 'namzu:openProject': Error: ENOENT: no such file or directory, realpath '/gone'",
	'TypeError: x is not a function\n    at run (/app/main.js:1:1)',
	'EPERM: operation not permitted, unlink C:\\a\\b',
	'Error: [object Object]',
]

describe('ChatErrorBanner', () => {
	it.each(RAW)(
		'never renders an error name, a remote-call prefix, a code or a stack: %#',
		(raw) => {
			const html = renderToStaticMarkup(createElement(ChatErrorBanner, { message: raw }))
			expect(html).not.toMatch(/Error invoking remote method/)
			expect(html).not.toMatch(/[A-Za-z]+Error\b/)
			expect(html).not.toMatch(/\bE(?:NOENT|PERM|ACCES)\b/)
			expect(html).not.toMatch(/\bat run\b|main\.js|\[object/)
		},
	)

	it('keeps the original behind a Details toggle that is closed at first', () => {
		const html = renderToStaticMarkup(
			createElement(ChatErrorBanner, {
				message: 'Couldn’t rename the project. Try again.',
				details: 'Something odd happened in the rename step',
			}),
		)
		expect(html).toContain('Couldn’t rename the project. Try again.')
		expect(html).toContain('Details')
		expect(html).toContain('aria-expanded="false"')
		expect(html).not.toContain('Something odd happened')
	})

	it('shows a sentence the product wrote as it is', () => {
		const html = renderToStaticMarkup(
			createElement(ChatErrorBanner, { message: 'Namzu is reconnecting.' }),
		)
		expect(html).toContain('Namzu is reconnecting.')
		expect(html).not.toContain('Details')
	})
})
