import { describe, expect, it } from 'vitest'

import { formatTuiExitSummary } from './exit-summary.js'

describe('the shell handoff after the TUI exits', () => {
	it('prints a copy-pasteable shell command for the durable conversation', () => {
		expect(formatTuiExitSummary({ conversationId: '5be5e0e7-6c3c-4013-971a-f75c0d2d2538' })).toBe(
			'To resume this conversation, run: namzu resume 5be5e0e7-6c3c-4013-971a-f75c0d2d2538\n',
		)
	})

	it('prints nothing before a durable conversation exists', () => {
		expect(formatTuiExitSummary(null)).toBe('')
		expect(formatTuiExitSummary({})).toBe('')
	})

	it('renders terminal control bytes visibly', () => {
		const output = formatTuiExitSummary({
			conversationId: 'ses_safe\u001b]2;spoof\u0007',
		})
		expect(output).toContain('\\u{001b}')
		expect(output).toContain('\\u{0007}')
		expect(output).not.toContain('\u001b')
		expect(output).not.toContain('\u0007')
	})
})
