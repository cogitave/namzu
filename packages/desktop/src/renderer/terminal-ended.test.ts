import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TerminalTabView } from '../shared/terminal-tabs.js'
import { ENDED_LABEL, TerminalBadge, endedNotice, terminalBadgeLabel } from './terminal-pane.js'

const shell = (over: Partial<TerminalTabView> = {}): TerminalTabView => ({
	id: 't1',
	projectId: 'p1',
	kind: 'shell',
	title: 'sh',
	status: 'exited',
	createdAt: 0,
	...over,
})

describe('an ended terminal', () => {
	it('uses one term, "terminal", and tells a stop from an exit', () => {
		expect(endedNotice(shell(), 0)).toBe('This terminal has ended.')
		expect(endedNotice(shell(), undefined)).toBe('This terminal has ended.')
		expect(endedNotice(shell(), 3)).toBe('This terminal has ended with code 3.')
		expect(endedNotice(shell(), undefined, 15)).toBe('The terminal was stopped.')
		expect(endedNotice(shell({ status: 'restored' }), undefined)).toContain('this terminal ended')
	})

	it('reads as Ended in the strip, with the hollow dot named for a screen reader and a tooltip', () => {
		expect(terminalBadgeLabel(shell())).toBe(ENDED_LABEL)
		expect(terminalBadgeLabel(shell({ status: 'running' }))).toBeUndefined()
		const html = renderToStaticMarkup(createElement(TerminalBadge, { tab: shell() }))
		expect(html).toContain('aria-label="Ended"')
		expect(html).toContain('title="Ended"')
		expect(html).not.toMatch(/session/i)
	})
})
