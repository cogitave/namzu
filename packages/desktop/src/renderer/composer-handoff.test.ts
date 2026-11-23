import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { DesktopTurnHandoff } from '../shared/protocol.js'
import { ComposerHandoff } from './composer-handoff.js'

const handoff: DesktopTurnHandoff = {
	turnId: 't',
	checkpointId: 'c',
	reason: 'The site asks you to sign in',
	tool: 'browser',
	cause: 'sign-in',
	origin: 'https://github.com',
	loginCommand: 'namzu browser login default https://github.com',
	window: 'visible',
}
const draw = (over: Partial<DesktopTurnHandoff> = {}, disabled = false) =>
	renderToStaticMarkup(
		createElement(ComposerHandoff, {
			handoff: { ...handoff, ...over },
			onContinue: () => undefined,
			onStop: () => undefined,
			disabled,
		}),
	)

it('says what is needed and offers Continue and Stop, with no dead-end sentence', () => {
	const html = draw()
	expect(html).toContain('Namzu is waiting for you')
	expect(html).toContain('Sign in to github.com in the browser window Namzu opened')
	expect(html).toMatch(/data-action="continue"[^>]*>Continue/)
	expect(html).toMatch(/data-action="stop"[^>]*>Stop/)
	expect(html).toContain('data-testid="handoff-card"')
	expect(html).not.toContain('waiting for a decision')
	// The command stays out of sight when a window is open.
	expect(html).not.toContain('namzu browser login')
})

it('shows the command to copy when the browser has no window', () => {
	const html = draw({ window: 'none' })
	expect(html).toContain('has no window of its own')
	expect(html).toContain('namzu browser login default https://github.com')
})

it('disables both buttons while the conversation cannot take an answer', () => {
	const html = draw({}, true)
	expect(html.match(/disabled=""/g)).toHaveLength(2)
})

it('reuses the approval card’s own ring, band and buttons, so it needs no numbers of its own', () => {
	const css = readFileSync(new URL('./composer-handoff.css', import.meta.url), 'utf8')
	expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
	expect(css).not.toMatch(/\d+px\s+solid/)
})

it('for a page in the Browser pane, offers a button that shows the tab, and no terminal command', () => {
	const html = renderToStaticMarkup(
		createElement(ComposerHandoff, {
			handoff: { ...handoff, window: 'pane' },
			onContinue: () => undefined,
			onStop: () => undefined,
			onShowTab: () => undefined,
		}),
	)
	expect(html).toContain('Sign in to github.com in the Browser pane, then choose Continue.')
	expect(html).toMatch(/data-action="show-tab"[^>]*>Show the tab/)
	expect(html).toMatch(/data-action="continue"[^>]*>Continue/)
	expect(html).toMatch(/data-action="stop"[^>]*>Stop/)
	expect(html).not.toContain('namzu browser login')
	// The other cards do not get the button.
	expect(draw()).not.toContain('show-tab')
})
