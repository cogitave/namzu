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
	it('names the opt-ins and refuses everything else in the tool text only', () => {
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain('"hypermode"')
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain('hypermode is on')
		expect(WORKFLOW_TOOL_DESCRIPTION).not.toContain('/workflow')
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain('do not call')
	})

	it('keeps the system prompt to a pointer: the opt-in list has one home', () => {
		expect(WORKFLOW_DOCTRINE).toContain('its description lists the opt-ins')
		expect(WORKFLOW_DOCTRINE).not.toContain('"hypermode"')
		expect(WORKFLOW_DOCTRINE).not.toContain('saved workflow')
		expect(WORKFLOW_DOCTRINE).toContain('hypermode is on')
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

describe('the description carries a sample call', () => {
	it('shows one call whose script parses as JSON with a literal meta first', () => {
		const at = WORKFLOW_TOOL_DESCRIPTION.indexOf('Example call')
		expect(at).toBeGreaterThan(-1)
		const line = WORKFLOW_TOOL_DESCRIPTION.slice(at).split('\n')[0] ?? ''
		const json = line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1)
		const call = JSON.parse(json) as { script: string; args: unknown }
		expect(call.script.startsWith('export const meta = {')).toBe(true)
		expect(call.script).toContain('parallel(')
		expect(call.args).toEqual({ packages: ['core', 'web'] })
	})
})
