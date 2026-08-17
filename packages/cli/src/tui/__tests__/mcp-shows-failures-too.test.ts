import { describe, expect, it } from 'vitest'

import { renderMcp } from '../slashCommands.js'

/**
 * A tool server that failed is indistinguishable, from the inside, from one
 * nobody configured — and that is the state an operator is in when a tool they
 * expected is simply absent.
 *
 * The connect-time transcript said so once and scrolled it away. Every
 * assertion here is about the page still being able to answer afterwards, and
 * about it never answering by omission.
 */

describe('renderMcp', () => {
	it('names a failure and its reason, not just the successes', () => {
		// The load-bearing one. A page that listed only what worked would look
		// correct and complete on a machine where nothing worked.
		const rendered = renderMcp({
			connected: [{ name: 'tickets', tools: ['mcp_tickets_create'] }],
			failed: [{ name: 'search', reason: 'command not found: uvx' }],
		})
		expect(rendered).toContain('search')
		expect(rendered).toContain('command not found: uvx')
		expect(rendered).toMatch(/NOT available/)
	})

	it('lists a failure even when nothing connected at all', () => {
		const rendered = renderMcp({
			connected: [],
			failed: [{ name: 'search', reason: 'timed out' }],
		})
		expect(rendered).toContain('timed out')
		expect(rendered).not.toMatch(/No tool servers configured/)
	})

	it('names the tools rather than only counting them', () => {
		// A count answers "did it work". The operator's actual question is
		// whether the tool they wanted is among them.
		const rendered = renderMcp({
			connected: [{ name: 'tickets', tools: ['mcp_tickets_create', 'mcp_tickets_search'] }],
			failed: [],
		})
		expect(rendered).toContain('mcp_tickets_create')
		expect(rendered).toContain('mcp_tickets_search')
	})

	it('says nothing is configured only when nothing is', () => {
		const rendered = renderMcp({ connected: [], failed: [] })
		expect(rendered).toMatch(/No tool servers configured/)
	})

	it('distinguishes "no session yet" from "no servers"', () => {
		// Two different facts. Reporting the second for the first tells an
		// operator their config is empty when it has simply not been read.
		expect(renderMcp(null)).toMatch(/No session yet/)
		expect(renderMcp(null)).not.toMatch(/No tool servers configured/)
	})
})
