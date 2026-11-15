import { describe, expect, it } from 'vitest'
import { EXPLORE_AGENT_DESCRIPTION, EXPLORE_AGENT_PROMPT } from '../explore.js'
import { PLAN_AGENT_DESCRIPTION, PLAN_AGENT_PROMPT } from '../plan.js'

describe('the explore prompt', () => {
	it('is read-only, reports what was not read, and prefers locating over auditing', () => {
		expect(EXPLORE_AGENT_PROMPT).toContain('read-only')
		expect(EXPLORE_AGENT_PROMPT).toContain('what you did not read')
		expect(EXPLORE_AGENT_PROMPT).toContain('prefer locating over auditing whole files')
		expect(EXPLORE_AGENT_PROMPT).not.toContain('answer only the part you can locate')
	})

	it('tells the agent to return as soon as the question is answered', () => {
		expect(EXPLORE_AGENT_PROMPT).toContain(
			'Return as soon as the question you were asked is answered',
		)
		expect(EXPLORE_AGENT_DESCRIPTION).toContain('returns as soon as')
		expect(PLAN_AGENT_PROMPT).toContain('Return as soon as you can write the plan')
		expect(PLAN_AGENT_DESCRIPTION).toContain('returns as soon as the plan can be written')
	})
})
