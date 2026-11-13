import { describe, expect, it } from 'vitest'

import { agentUsageText, wroteBy, wroteLineText, wroteOf, wroteRailText } from './agent-tokens.js'

describe('what an agent wrote', () => {
	it('is nothing until some usage arrives, and zero is the same as nothing', () => {
		expect(wroteOf({})).toBeUndefined()
		expect(wroteOf({ outputTokens: 0 })).toBeUndefined()
		expect(wroteRailText(wroteOf({}))).toBeUndefined()
		expect(wroteOf({ outputTokens: 6_200 })).toBe(6_200)
	})

	it("reads with the main row's arrow on the rail and in words in the transcript", () => {
		expect(wroteRailText(6_200)).toBe('↓ 6.2k tokens')
		expect(wroteLineText(6_200)).toBe('6.2k tokens written')
	})

	it('adds up only the agents that reported', () => {
		expect(wroteBy([{}, {}])).toBeUndefined()
		expect(wroteBy([{ outputTokens: 1_200 }, {}, { outputTokens: 300 }])).toBe(1_500)
	})
})

describe('the full picture of one agent', () => {
	it('says what it wrote, what it was sent and how much of that came from the cache', () => {
		expect(
			agentUsageText({ outputTokens: 6_200, sentTokens: 1_170_000, cachedTokens: 980_000 }),
		).toBe('wrote 6.2k · sent 1.17M (980.0k cached)')
	})

	it('leaves the cache out when the driver reported none, or more than was sent', () => {
		expect(agentUsageText({ outputTokens: 6_200, sentTokens: 1_170_000, cachedTokens: 0 })).toBe(
			'wrote 6.2k · sent 1.17M',
		)
		expect(agentUsageText({ outputTokens: 10, sentTokens: 100, cachedTokens: 5_000 })).toBe(
			'wrote 10 · sent 100',
		)
	})

	it('says nothing when no usage has arrived', () => {
		expect(agentUsageText({})).toBeUndefined()
	})
})
