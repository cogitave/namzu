import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { WORKFLOW_DOCTRINE } from '../../integrations/workflows/doctrine.js'
import {
	NAMZU_DELEGATION_DOCTRINE,
	NAMZU_PLAN_FILE_DOCTRINE,
	NAMZU_PLAN_MODE_DOCTRINE,
	NAMZU_WORKING_DOCTRINE,
} from '../doctrine.js'
import { NAMZU_IDENTITY } from '../identity.js'
import {
	DEFERRED_TOOL_GUIDANCE,
	type SessionPromptInput,
	composeSessionSystemPrompt,
} from '../system-prompt.js'

const state: SessionPromptInput = {
	resident: false,
	browserDesktopRouting: 'ROUTING',
	palBlock: 'PALS',
	environment: 'ENVIRONMENT',
	delegationAvailable: true,
	workflowOffered: false,
	conversationEvidence: 'EVIDENCE',
	toolsDeferred: true,
	permissionMode: 'auto',
	systemNote: 'NOTE',
	skillsOverflowNote: 'OVERFLOW',
}

const compose = (over: Partial<SessionPromptInput> = {}) =>
	composeSessionSystemPrompt({ ...state, ...over }) ?? ''

describe('the session system prompt', () => {
	it('is the same text for a new turn and a resumed turn that hold the same state', () => {
		// Both paths in `tui/agent.ts` call this function with the facts they hold;
		// identical facts must give identical bytes.
		expect(compose()).toBe(compose({ resident: false }))
	})

	it('keeps its static prefix byte-stable from one turn to the next', () => {
		const first = compose()
		const second = compose()
		expect(second).toBe(first)
		// A mode change only appends one section; nothing before it moves.
		const planned = compose({ permissionMode: 'plan' })
		expect(planned.startsWith(first.slice(0, first.indexOf('ENVIRONMENT')))).toBe(true)
	})

	it('gives a resumed turn the deferred-tool guidance, plan doctrine and note', () => {
		const text = compose({ permissionMode: 'plan', planPath: '/tmp/plan.md' })
		expect(text).toContain(DEFERRED_TOOL_GUIDANCE)
		expect(text).toContain(NAMZU_PLAN_FILE_DOCTRINE)
		expect(text).toContain('NOTE')
		expect(text).not.toContain(NAMZU_PLAN_MODE_DOCTRINE)
	})

	it('uses the plan-mode doctrine when the session has no plan file', () => {
		expect(compose({ permissionMode: 'plan' })).toContain(NAMZU_PLAN_MODE_DOCTRINE)
	})

	it('offers the workflow rule only with the workflow tool, and delegation only with the Agent tool', () => {
		expect(compose()).not.toContain(WORKFLOW_DOCTRINE)
		expect(compose({ workflowOffered: true })).toContain(WORKFLOW_DOCTRINE)
		expect(compose()).toContain(NAMZU_DELEGATION_DOCTRINE)
		expect(compose({ delegationAvailable: false })).not.toContain(NAMZU_DELEGATION_DOCTRINE)
	})

	it('leaves out the deferred-tool guidance when nothing is deferred', () => {
		expect(compose({ toolsDeferred: false })).not.toContain(DEFERRED_TOOL_GUIDANCE)
	})

	it('gives a resident step the identity and routing, not the working policy or the environment', () => {
		const text = compose({ resident: true, permissionMode: 'plan', extraSystem: 'EXTRA' })
		expect(text).toContain(NAMZU_IDENTITY)
		expect(text).toContain('ROUTING')
		expect(text).toContain('EVIDENCE')
		expect(text).toContain('OVERFLOW')
		for (const absent of [
			NAMZU_WORKING_DOCTRINE,
			NAMZU_DELEGATION_DOCTRINE,
			NAMZU_PLAN_MODE_DOCTRINE,
			'PALS',
			'ENVIRONMENT',
			'EXTRA',
			'NOTE',
		]) {
			expect(text).not.toContain(absent)
		}
	})

	it('is the only place that lists the sections: the agent file names none of the doctrines', () => {
		const source = readFileSync(
			fileURLToPath(new URL('../../tui/agent.ts', import.meta.url)),
			'utf8',
		)
		for (const name of [
			'NAMZU_IDENTITY',
			'NAMZU_WORKING_DOCTRINE',
			'NAMZU_DELEGATION_DOCTRINE',
			'NAMZU_PLAN_MODE_DOCTRINE',
			'NAMZU_PLAN_FILE_DOCTRINE',
			'WORKFLOW_DOCTRINE',
		]) {
			expect(source, name).not.toContain(name)
		}
		expect(source.match(/composeSessionSystemPrompt\(/g)).toHaveLength(2)
	})
})
