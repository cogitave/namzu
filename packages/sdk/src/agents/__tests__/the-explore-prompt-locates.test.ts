import { describe, expect, it } from 'vitest'
import { EXPLORE_AGENT_PROMPT } from '../explore.js'

describe('the explore prompt', () => {
	it('is read-only, reports what was not read, and prefers locating over auditing', () => {
		expect(EXPLORE_AGENT_PROMPT).toContain('read-only')
		expect(EXPLORE_AGENT_PROMPT).toContain('what you did not read')
		expect(EXPLORE_AGENT_PROMPT).toContain('prefer locating over auditing whole files')
		expect(EXPLORE_AGENT_PROMPT).not.toContain('answer only the part you can locate')
	})
})
