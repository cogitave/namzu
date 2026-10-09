import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { describeBlockedRetry, describeFailure } from './friendly-errors.js'
import { TurnRecovery, recoveryActions } from './turn-recovery.js'

const retry = { turnId: 'turn', checkpointId: 'checkpoint' }
const render = (props: Parameters<typeof TurnRecovery>[0]) =>
	renderToStaticMarkup(createElement(TurnRecovery, props))

it('offers Try again only for a host-supplied target and callable capability', () => {
	expect(render({})).toBe('')
	expect(render({ retry })).toBe('')
	expect(render({ onRetry: () => {} })).toBe('')
	expect(render({ retry, onRetry: () => {} })).toContain('Try again')
	expect(render({ retry, disabled: true, onRetry: () => {} })).toContain('disabled=""')
})

it('says a failure in plain words with the original behind Details', () => {
	const failure = describeFailure(
		'openai (HTTP 502) — the provider failed to complete the request: 502 <html><body>502 Bad Gateway</body></html>',
	)
	const html = render({ failures: [failure], retry, onRetry: () => {} })
	expect(html).toContain('OpenAI had a problem on its side')
	expect(html).toContain('Try again')
	expect(html).toContain('<summary>Details</summary>')
	// The main text carries no code, markup or internal word.
	const main = html.slice(0, html.indexOf('<details'))
	expect(main).not.toMatch(/502|html|HTTP|receipt|retained|token/i)
})

it('does not offer Try again when nothing can be repeated, but offers a way out', () => {
	const blocked = describeBlockedRetry(
		'This provider request has unresolved token usage. Retry requires its actual provider usage receipt; the original turn is retained.',
	)
	const html = render({ failures: [blocked] })
	expect(html).not.toContain('Try again')
	expect(html).toContain('Start a new conversation')
	expect(html).toContain('Your message is saved above')
	expect(html.slice(0, html.indexOf('<details'))).not.toMatch(/receipt|unresolved|retained/i)
})

it('lists each action once, with the first one drawn as the primary', () => {
	const rejected = describeFailure(
		'anthropic (HTTP 401) — the provider rejected the request credentials',
	)
	expect(recoveryActions([rejected, rejected], true)).toEqual(['settings'])
	const html = render({ failures: [rejected], onAction: () => {} })
	expect(html).toContain('Open model settings')
})
