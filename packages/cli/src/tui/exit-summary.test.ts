import { describe, expect, it } from 'vitest'

import { formatTuiExitSummary } from './exit-summary.js'

describe('the shell handoff after the TUI exits', () => {
	it('prints a copy-pasteable shell command for the durable conversation', () => {
		expect(formatTuiExitSummary({ conversationId: 'ses_123' })).toBe(
			'To resume this conversation, run: namzu resume ses_123\n',
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
