import { parseWorkflowMeta } from '@namzu/sdk'
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
	it('tells the model a failed thunk becomes null but a script mistake fails the run', () => {
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain(
			'A thunk that throws, or whose agent failed, becomes null',
		)
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain('A stage that throws drops its item to null')
		expect(WORKFLOW_TOOL_DESCRIPTION).toContain('fails the whole run with an error')
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

	it('sends a status question to the run’s state, not to the launch receipt', () => {
		expect(WORKFLOW_DOCTRINE).toContain('how a workflow is going')
		expect(WORKFLOW_DOCTRINE).toContain('`agent_task_list`')
		expect(WORKFLOW_DOCTRINE).toContain('which is only a receipt')
		expect(WORKFLOW_DOCTRINE).toContain('still running until its message has arrived')
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

describe('the wording rules the model reads', () => {
	const lines = WORKFLOW_TOOL_DESCRIPTION.split('\n')
	const metaLine = lines.find((line) => line.startsWith('export const meta')) ?? ''
	const exampleCall = lines.find((line) => line.startsWith('Example call')) ?? ''
	const exampleScript = JSON.parse(
		exampleCall.slice(exampleCall.indexOf('{"script"')).replace(/\.$/, ''),
	).script as string

	it('states each convention and the limits that go with it, in a short paragraph', () => {
		const rules = lines.find((line) => line.startsWith('The operator reads these words')) ?? ''
		for (const needle of [
			'lower-case words joined by hyphens, a verb first',
			'at most 80 characters',
			'one plain line',
			'no method words',
			'at most 500',
			'one entry per stage',
			'one or two capitalised words',
			'letter for letter in phase() and opts.phase',
			'case is ignored when matching',
			'at most 300',
			'kind:target under 40 characters',
			'first 60 characters of the prompt',
			'short facts with counts',
			'left out whenever the script capped something',
		]) {
			expect(rules).toContain(needle)
		}
		expect(rules.length).toBeLessThan(900)
	})

	it('follows its own rules in both examples', () => {
		for (const source of [metaLine, exampleScript]) {
			const meta = parseWorkflowMeta(source)
			expect(meta.name).toMatch(/^[a-z]+(-[a-z]+)*$/)
			expect(meta.description.length).toBeLessThan(120)
			expect(meta.phases.length).toBeGreaterThan(0)
			for (const phase of meta.phases) {
				expect(phase.title).toMatch(/^[A-Z][a-z]*( [A-Z]?[a-z]+)?$/)
				expect(phase.detail).toBeDefined()
			}
		}
		const used = exampleScript.match(/label: "([^"]*)"/)
		expect(used?.[1]).toMatch(/^[a-z]+:$/)
		expect(exampleScript).toContain('phase: "Scan"')
	})
})
