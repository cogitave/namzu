import { describe, expect, it } from 'vitest'

import {
	WORKFLOW_TOOL_DESCRIPTION,
	messageAsksForWorkflow,
	workflowCommandPrompt,
	workflowOffered,
	workflowRefusal,
} from '../offering.js'

describe('when the workflow tool is offered', () => {
	it('is not offered to an ordinary message', () => {
		expect(workflowOffered({ hypermode: false, userText: 'fix the failing test in cart.ts' })).toBe(
			false,
		)
		expect(workflowOffered({ hypermode: false, userText: '' })).toBe(false)
	})

	it('is offered whenever hypermode is on, whatever the message says', () => {
		expect(workflowOffered({ hypermode: true, userText: 'fix the failing test' })).toBe(true)
	})

	it.each([
		'use a workflow to audit the packages',
		'Run a WORKFLOW over all of them',
		'workflow: scan then fix',
		'make the workflows smaller',
		'/workflow audit the packages',
		'bir iş akışı kur',
		'İş Akışı ile tara',
		'IŞ AKIŞI başlat',
		'is akisi olustur',
		'iş akışları nelerdi',
	])('is offered when the message asks for one: %s', (text) => {
		expect(messageAsksForWorkflow(text)).toBe(true)
		expect(workflowOffered({ hypermode: false, userText: text })).toBe(true)
	})

	it.each([
		'rework the flow of the checkout',
		'my network workflowless setup',
		'is akıllı değil',
		'akış kontrolü ekle',
	])('is not offered when the word only sits inside another: %s', (text) => {
		expect(messageAsksForWorkflow(text)).toBe(false)
	})

	it('turns /workflow <task> into a message that asks for one', () => {
		const prompt = workflowCommandPrompt('  audit the packages ')
		expect(prompt).toBe('Use a workflow for this: audit the packages')
		expect(messageAsksForWorkflow(prompt)).toBe(true)
		expect(messageAsksForWorkflow(workflowCommandPrompt(''))).toBe(true)
	})
})

describe('who may start one', () => {
	it('lets a turn with someone to review it start one', () => {
		expect(workflowRefusal({ interactive: true, mode: 'prompt' })).toBeUndefined()
		expect(workflowRefusal({ interactive: true, mode: 'accept-edits' })).toBeUndefined()
	})

	it('lets a session set to run without asking start one, with nobody there', () => {
		expect(workflowRefusal({ interactive: false, mode: 'auto' })).toBeUndefined()
	})

	it('refuses, in plain words, when nobody can review it and the session still asks', () => {
		for (const mode of ['prompt', 'accept-edits', 'strict', 'plan']) {
			const reason = workflowRefusal({ interactive: false, mode })
			expect(reason).toContain('nobody to ask')
			expect(reason).toContain('--permission-mode auto')
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
