import { describe, expect, it } from 'vitest'

import { WORKFLOW_DOCTRINE } from '../doctrine.js'
import { WORKFLOW_TOOL_DESCRIPTION, workflowRefusal } from '../offering.js'

describe('who may start one', () => {
	it('lets a turn with someone to review it start one', () => {
		expect(workflowRefusal({ interactive: true, mode: 'prompt' })).toBeUndefined()
		expect(workflowRefusal({ interactive: true, mode: 'accept-edits' })).toBeUndefined()
	})

	it('lets a session set to run without asking start one, with nobody there', () => {
		expect(workflowRefusal({ interactive: false, mode: 'auto' })).toBeUndefined()
		expect(workflowRefusal({ interactive: false, mode: 'bypass' })).toBeUndefined()
	})

	it('refuses, in plain words, when nobody can review it and the session still asks', () => {
		for (const mode of ['prompt', 'accept-edits', 'strict', 'plan', 'classify']) {
			const reason = workflowRefusal({ interactive: false, mode })
			expect(reason).toContain('nobody to ask')
			expect(reason).toContain('--permission-mode bypass')
		}
	})
})

describe('the description the model reads', () => {
	it('covers the language and its limits', () => {
		for (const needle of [
			'export const meta',
			'agent(prompt',
			'parallel(',
			'pipeline(',
			'phase(title)',
			'log(message)',
			'args',
			'budget',
			'null',
			'8000',
			'Agent tool',
			'approves or declines',
		]) {
			expect(WORKFLOW_TOOL_DESCRIPTION).toContain(needle)
		}
	})
})

describe('what the tool description says about failures', () => {
	it('tells the model parallel and pipeline never reject and to filter nulls', () => {
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain('never rejects: a thunk that throws becomes null')
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain('a stage that throws drops its item to null')
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain('filter the nulls')
	})
})

describe('the opt-in rule the model reads', () => {
	it('names the opt-ins and refuses everything else, in the tool text and the doctrine', () => {
		for (const text of [WORKFLOW_TOOL_DESCRIPTION, WORKFLOW_DOCTRINE]) {
			expect(text).toContain('"hypermode"')
			expect(text).toContain('hypermode is on')
			expect(text).not.toContain('/workflow')
			expect(text).toContain('do not call')
		}
	})

	it('points to the quality patterns', () => {
		for (const pattern of [
			'adversarial verify',
			'judge panel',
			'loop until dry',
			'completeness critic',
		])
			expect(WORKFLOW_TOOL_DESCRIPTION).toContain(pattern)
	})
})
