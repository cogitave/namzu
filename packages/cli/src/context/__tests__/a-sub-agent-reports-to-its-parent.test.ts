import { describe, expect, it } from 'vitest'

import { SUBAGENT_PROMPT } from '../../integrations/subagents/runtime.js'
import { NAMZU_CHILD_WORKING_DOCTRINE, NAMZU_WORKING_DOCTRINE } from '../doctrine.js'
import { composeEnvironmentPrompt } from '../environment.js'

const FRAMING = 'These are facts about right now.'

describe('a sub-agent prompt reports to its parent', () => {
	it('has no section about keeping the user informed, and one about the final report', () => {
		expect(NAMZU_WORKING_DOCTRINE).toContain('### Keeping the user informed')
		expect(NAMZU_CHILD_WORKING_DOCTRINE).not.toContain('Keeping the user informed')
		expect(NAMZU_CHILD_WORKING_DOCTRINE).toContain('### Your final report')
		expect(SUBAGENT_PROMPT).not.toContain('Keep the final reply short')
		expect(SUBAGENT_PROMPT).not.toContain('Before a batch of tool calls')
	})

	it('asks for a complete report without filler, in one place', () => {
		expect(SUBAGENT_PROMPT).not.toContain('Be thorough, and state every assumption')
		expect(SUBAGENT_PROMPT).toContain('complete')
		expect(SUBAGENT_PROMPT).toContain('leave out filler')
		expect(SUBAGENT_PROMPT).toContain('an AI kernel')
	})
})

describe('the environment block opens with its framing line', () => {
	const facts = { today: '2026-10-27', isRepository: true, branch: 'main', cwd: '/w' }

	it('leads the block, before any fact', () => {
		const block = composeEnvironmentPrompt(facts as never)
		const body = block.split('\n\n')[1] ?? ''
		expect(body.startsWith(FRAMING)).toBe(true)
		expect(block.trimEnd().endsWith(FRAMING)).toBe(false)
	})

	it('leads a delegated block too', () => {
		const block = composeEnvironmentPrompt({
			...facts,
			boundary: { delegated: true, interactive: false, mode: 'prompt' },
		} as never)
		expect((block.split('\n\n')[1] ?? '').startsWith(FRAMING)).toBe(true)
	})

	it('is absent from the stable form', () => {
		expect(composeEnvironmentPrompt(facts as never, { stable: true })).not.toContain(FRAMING)
	})
})
