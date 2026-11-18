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

	it('keeps the finishing, fix-what-is-broken and investigation rules, and sends nobody to a person', () => {
		for (const rule of [
			'### Finishing the work',
			'never close on a plan or a promise of later work',
			'Context is compacted automatically',
			'is a request to fix it, unless the person says they only want a diagnosis',
			'An investigation continues until the cause is found',
		]) {
			expect(NAMZU_CHILD_WORKING_DOCTRINE, rule).toContain(rule)
		}
		expect(NAMZU_CHILD_WORKING_DOCTRINE).not.toContain('Ask once')
		expect(NAMZU_CHILD_WORKING_DOCTRINE).not.toContain('stop and ask')
	})

	it('asks for a complete report without filler, in one place', () => {
		expect(SUBAGENT_PROMPT).not.toContain('Be thorough, and state every assumption')
		expect(SUBAGENT_PROMPT).toContain('complete')
		expect(SUBAGENT_PROMPT).toContain('without filler')
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

describe('the environment block is background, not something to recite', () => {
	it('says so in the block and in the first-turn reminder', async () => {
		const { environmentReminders } = await import('../../reminders/environment.js')
		const facts = { today: '2026-10-27', isRepository: true, branch: 'main', cwd: '/w' }
		expect(composeEnvironmentPrompt(facts as never)).toContain(
			'Do not narrate them unless asked or relevant',
		)
		expect(environmentReminders({ messages: [], facts: facts as never })[0]).toContain(
			'Do not narrate them unless asked or relevant',
		)
	})

	it('tells the working rules to answer about the work and keep the setting quiet', () => {
		expect(NAMZU_WORKING_DOCTRINE).toContain('Answer about the work, not about the setting.')
	})
})
