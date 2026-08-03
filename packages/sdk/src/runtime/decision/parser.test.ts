import { describe, expect, it } from 'vitest'
import { getRootLogger } from '../../utils/logger.js'
import { DecisionParser } from './parser.js'

function makeParser(): DecisionParser {
	return new DecisionParser(
		{
			validAgentIds: ['agent-a'],
			minConfidence: 0,
			maxRetries: 1,
			fallbackAgentId: 'agent-a',
		},
		getRootLogger(),
	)
}

describe('DecisionParser', () => {
	it('extracts JSON from a fenced code block', () => {
		const parser = makeParser()
		const raw = '```json\n{"agentId":"agent-a","confidence":0.9}\n```'

		const result = parser.parse(raw)

		expect(result.ok).toBe(true)
	})

	// `codeBlockMatch` used `\s*\n?` on both sides of a lazy `[\s\S]*?`
	// capture — whitespace and the capture overlap, so an unterminated
	// fence forces the engine to explore every way of splitting the same
	// run of blank lines between them. The trailing non-whitespace `x`
	// keeps `.trim()` from stripping the blank-line run before the regex
	// ever runs. A ~1KB unterminated fence (well within a single routing
	// completion) used to take multiple seconds; this pins it to
	// comfortably sub-second.
	it('does not exhibit super-linear backtracking on an unterminated fence with many blank lines', () => {
		const parser = makeParser()
		const raw = `\`\`\`json${'\n'.repeat(1000)}x`

		const start = Date.now()
		const result = parser.parse(raw)
		const elapsed = Date.now() - start

		expect(elapsed).toBeLessThan(500)
		expect(result.ok).toBe(false)
	})
})
