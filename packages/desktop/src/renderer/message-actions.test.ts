import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { MessageActions } from './message-actions.js'

const render = (props: Parameters<typeof MessageActions>[0]) =>
	renderToStaticMarkup(createElement(MessageActions, props))

it('keeps the settled row: Retry then Copy reply, nothing else', () => {
	const html = render({ text: 'hello', onRetry: () => {} })
	expect(html.indexOf('aria-label="Retry"')).toBeGreaterThan(-1)
	expect(html.indexOf('aria-label="Retry"')).toBeLessThan(html.indexOf('aria-label="Copy reply"'))
	expect(html).toContain('class="message-actions"')
})

it('has no Retry without a handler, and Copy is disabled for empty text', () => {
	const html = render({ text: '' })
	expect(html).not.toContain('aria-label="Retry"')
	expect(html).toMatch(/aria-label="Copy reply"[^>]*disabled/)
})

it('can rename and disable Retry, rename Copy and carry quiet items after Copy', () => {
	const html = render({
		text: 'x',
		onRetry: () => {},
		retryLabel: 'Retry with GPT-5',
		retryDisabled: true,
		copyLabel: 'Copy',
		className: 'message-actions-wrap',
		after: createElement('span', null, 'tail'),
	})
	expect(html).toContain('aria-label="Retry with GPT-5"')
	expect(html).toContain('aria-label="Copy"')
	expect(html).toContain('class="message-actions message-actions-wrap"')
	expect(html.indexOf('aria-label="Copy"')).toBeLessThan(html.indexOf('tail'))
})
