import { describe, expect, it } from 'vitest'

import {
	WORKFLOW_TOOL_DESCRIPTION,
	isWorkflowCommandPrompt,
	workflowCommandPrompt,
	workflowOffered,
	workflowRefusal,
} from '../offering.js'

describe('when the workflow tool is offered', () => {
	const none = { hypermode: false, workflow: false }

	it('is not offered to an ordinary message', () => {
		expect(workflowOffered({ ...none, userText: 'fix the failing test in cart.ts' })).toBe(false)
		expect(workflowOffered({ ...none, userText: '' })).toBe(false)
	})

	it('is offered whenever hypermode is on, whatever the message says', () => {
		expect(workflowOffered({ ...none, hypermode: true, userText: 'fix the failing test' })).toBe(
			true,
		)
	})

	it('is offered when the workflow trigger is armed for the turn', () => {
		expect(workflowOffered({ ...none, workflow: true, userText: 'audit the packages' })).toBe(true)
	})

	it.each([
		'use a workflow to audit the packages',
		'how does the build workflow cache work?',
		'bir iş akışı kur',
	])('the word alone offers nothing; the composer trigger does that: %s', (text) => {
		expect(workflowOffered({ ...none, userText: text })).toBe(false)
	})

	it('turns /workflow <task> into a message that offers one', () => {
		const prompt = workflowCommandPrompt('  audit the packages ')
		expect(prompt).toBe('Use a workflow for this: audit the packages')
		expect(isWorkflowCommandPrompt(prompt)).toBe(true)
		expect(isWorkflowCommandPrompt(workflowCommandPrompt(''))).toBe(true)
		expect(workflowOffered({ ...none, userText: prompt })).toBe(true)
	})
})

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
