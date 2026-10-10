import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { describeBlockedRetry, describeFailure } from './friendly-errors.js'
import { TurnRecovery, recoveryActions } from './turn-recovery.js'

const retry = { turnId: 'turn', checkpointId: 'checkpoint' }
const render = (props: Parameters<typeof TurnRecovery>[0]) =>
	renderToStaticMarkup(createElement(TurnRecovery, props))

const sentenceOf = (html: string) => html.slice(0, html.indexOf('<div class="message-actions'))

it('offers Retry only for a host-supplied target and callable capability', () => {
	expect(render({})).toBe('')
	expect(render({ retry })).toBe('')
	expect(render({ onRetry: () => {} })).toBe('')
	const html = render({ retry, onRetry: () => {} })
	expect(html).toContain('aria-label="Retry"')
	expect(html).not.toContain('Try again')
	expect(render({ retry, disabled: true, onRetry: () => {} })).toContain('disabled=""')
	expect(render({ retry, model: 'GPT-5', onRetry: () => {} })).toContain(
		'aria-label="Retry with GPT-5"',
	)
})

it('says a failure in plain words with the original behind Details', () => {
	const failure = describeFailure(
		'openai (HTTP 502) — the provider failed to complete the request: 502 <html><body>502 Bad Gateway</body></html>',
	)
	const html = render({ failures: [failure], retry, onRetry: () => {} })
	expect(html).toContain('OpenAI had a problem on its side')
	expect(html).toContain('aria-label="Retry"')
	expect(html).toContain('aria-label="Copy"')
	// Details is a text toggle, not a native disclosure, and starts collapsed.
	expect(html).not.toMatch(/<details|<summary/)
	expect(html).toMatch(/aria-expanded="false" aria-controls="[^"]+">Details<\/button>/)
	expect(html).toMatch(/class="turn-recovery-details-text" hidden=""/)
	// The main text carries no code, markup or internal word.
	const main = sentenceOf(html)
	expect(main).not.toMatch(/502|html|HTTP|receipt|retained|token/i)
})

it('does not offer Retry when nothing can be repeated, but offers a way on in the same conversation', () => {
	const blocked = describeBlockedRetry(
		'This provider request has unresolved token usage. Retry requires its actual provider usage receipt; the original turn is retained.',
	)
	const html = render({ failures: [blocked] })
	expect(html).not.toContain('aria-label="Retry"')
	expect(html).toContain('Continue without this reply')
	expect(html).not.toContain('Start a new conversation')
	expect(html).toContain('put your message back in the message box')
	expect(sentenceOf(html)).not.toMatch(/receipt|unresolved|retained/i)
})

it('offers to copy the message to a new conversation only when asked to', () => {
	const blocked = describeBlockedRetry('The paused turn’s checkpoint is unavailable.')
	const html = render({
		failures: [{ ...blocked, actions: [...blocked.actions, 'copy-to-new'] }],
		onAction: () => {},
	})
	expect(html).toContain('Continue without this reply')
	expect(html).toContain('Copy to a new conversation')
})

it('lists each action once, as quiet text after the icons', () => {
	const rejected = describeFailure(
		'anthropic (HTTP 401) — the provider rejected the request credentials',
	)
	expect(recoveryActions([rejected, rejected], true)).toEqual(['settings'])
	const html = render({ failures: [rejected], onAction: () => {} })
	expect(html).toContain('Open model settings')
})

it('puts Retry, Copy, the quiet actions, Details and the time on one row, in that order', () => {
	const blocked = describeBlockedRetry('The paused turn’s checkpoint is unavailable.')
	const html = render({
		retry,
		onRetry: () => {},
		onAction: () => {},
		time: { at: Date.UTC(2026, 9, 10, 12, 0), source: 'host' },
		failures: [{ ...blocked, actions: ['try-again', ...blocked.actions], details: 'Raw text' }],
	})
	const order = [
		'aria-label="Retry"',
		'aria-label="Copy"',
		'>Continue without this reply<',
		'>Details<',
		'<time',
	]
	const at = order.map((needle) => html.indexOf(needle))
	expect(at.every((index) => index >= 0)).toBe(true)
	expect([...at].sort((a, b) => a - b)).toEqual(at)
	// Nothing is drawn as a filled or outlined button.
	expect(html).not.toMatch(/bg-primary|bg-popover|border-input/)
	// The row is MessageActions' own row, not a copy of it.
	expect(html).toContain('class="message-actions message-actions-wrap"')
})
