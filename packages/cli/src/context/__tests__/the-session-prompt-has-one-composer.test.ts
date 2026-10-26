import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CONVERSATION_EVIDENCE_GUIDANCE } from '../../integrations/sessions/conversation-search.js'
import { WORKFLOW_DOCTRINE } from '../../integrations/workflows/doctrine.js'
import { workflowSizeAdvice } from '../../integrations/workflows/size.js'
import {
	NAMZU_DELEGATION_DOCTRINE,
	NAMZU_PLAN_FILE_DOCTRINE,
	NAMZU_PLAN_MODE_DOCTRINE,
	NAMZU_WORKING_DOCTRINE,
} from '../doctrine.js'
import { composeEnvironmentPrompt } from '../environment.js'
import { AGENT_LAUNCH_TOOL, NAMZU_IDENTITY } from '../identity.js'
import {
	DEFERRED_TOOL_GUIDANCE,
	type SessionPromptFacts,
	type SessionPromptInput,
	type SessionPromptTurn,
	composeSessionSystemPrompt,
	sessionPromptInput,
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
	// What both assembly sites in `tui/agent.ts` hand over: the same facts, and
	// the few things that belong to the turn.
	const facts: SessionPromptFacts = {
		browserDesktopRouting: 'ROUTING',
		palBlock: 'PALS',
		environment: 'ENVIRONMENT',
		conversationSessions: {},
		anyToolDeferred: true,
		skillsOverflowNote: 'OVERFLOW',
	}
	const newTurn: SessionPromptTurn = {
		resident: false,
		workflowOffered: false,
		permissionMode: 'auto',
		extraSystem: 'SKILLS',
		systemNote: 'NOTE',
	}
	const fromFacts = (f: Partial<SessionPromptFacts> = {}, t: Partial<SessionPromptTurn> = {}) =>
		composeSessionSystemPrompt(sessionPromptInput({ ...facts, ...f }, { ...newTurn, ...t })) ?? ''

	it('is the same text for a new turn and a resumed turn that hold the same facts', () => {
		// The resumed turn differs from a new one only in the workflow tool it is
		// not offered; give the new turn the same toolset and the bytes match.
		const resumed = fromFacts()
		expect(fromFacts({}, { workflowOffered: false })).toBe(resumed)
		expect(resumed).toContain('SKILLS')
		expect(resumed).toContain('NOTE')
	})

	it('says the workflow size guideline right after the workflow doctrine, only when it is offered', () => {
		const advice = workflowSizeAdvice('medium', false)
		const offered = fromFacts({ workflowSizeAdvice: advice }, { workflowOffered: true })
		expect(offered).toContain(`${WORKFLOW_DOCTRINE}\n\n${advice}`)
		const notOffered = fromFacts({ workflowSizeAdvice: advice }, { workflowOffered: false })
		expect(notOffered).not.toContain(advice)
		expect(fromFacts({ workflowSizeAdvice: '' }, { workflowOffered: true })).toBe(
			fromFacts({}, { workflowOffered: true }),
		)
	})

	it('differs from a new turn that is offered the workflow tool by exactly that rule', () => {
		const resumed = fromFacts()
		const offered = fromFacts({}, { workflowOffered: true })
		expect(offered).toContain(WORKFLOW_DOCTRINE)
		expect(offered.replace(`${WORKFLOW_DOCTRINE}\n\n`, '')).toBe(resumed)
	})

	it.each([
		[
			'the Agent tool is withheld',
			{ withheldTools: [AGENT_LAUNCH_TOOL] },
			NAMZU_DELEGATION_DOCTRINE,
		],
		['nothing is deferred', { anyToolDeferred: false }, DEFERRED_TOOL_GUIDANCE],
		[
			'there are no conversation sessions',
			{ conversationSessions: undefined },
			CONVERSATION_EVIDENCE_GUIDANCE,
		],
	] as const)('drops one section when %s, and only that section', (_name, change, gone) => {
		const full = fromFacts()
		const less = fromFacts(change)
		expect(full).toContain(gone)
		expect(less).not.toContain(gone)
		expect(less.length).toBeLessThan(full.length)
		expect(full.replace(gone, '').replace(/\n{3,}/g, '\n\n')).toBe(less)
	})

	it('treats deferred tool loading as deferred even when no tool is marked', () => {
		expect(fromFacts({ toolLoading: 'deferred', anyToolDeferred: false })).toContain(
			DEFERRED_TOOL_GUIDANCE,
		)
	})

	it('keeps the prefix before the first per-turn section identical across turns that differ in them', () => {
		const one = fromFacts(
			{ environment: 'ENVIRONMENT one' },
			{ extraSystem: 'SKILLS one', systemNote: 'NOTE one' },
		)
		const two = fromFacts(
			{ environment: 'ENVIRONMENT two' },
			{ extraSystem: 'SKILLS two', systemNote: undefined },
		)
		const stable = fromFacts(
			{ environment: undefined, skillsOverflowNote: undefined },
			{
				extraSystem: undefined,
				systemNote: undefined,
			},
		)
		expect(one).not.toBe(two)
		expect(one.startsWith(stable)).toBe(true)
		expect(two.startsWith(stable)).toBe(true)
		expect(one.slice(0, one.indexOf('ENVIRONMENT'))).toBe(two.slice(0, two.indexOf('ENVIRONMENT')))
	})

	it('adds the plan doctrine to the prefix as one section when plan mode starts, and moves nothing else', () => {
		// The doctrine sits in the cached prefix, so a mode switch re-keys it
		// once; this pins that it is the only thing that switch changes.
		const auto = fromFacts()
		const plan = fromFacts({}, { permissionMode: 'plan' })
		expect(plan.replace(`${NAMZU_PLAN_MODE_DOCTRINE}\n\n`, '')).toBe(auto)
	})

	it('leaves the whole system prompt byte-identical across a new day and a checkout', () => {
		const environmentOn = (today: string, branch: string) =>
			composeEnvironmentPrompt(
				{ today, branch, isRepository: true, boundary: { escape: 'ask', interactive: true } },
				{ stable: true },
			)
		const monday = fromFacts({ environment: environmentOn('2026-10-26', 'main') })
		expect(fromFacts({ environment: environmentOn('2026-10-27', 'main') })).toBe(monday)
		expect(fromFacts({ environment: environmentOn('2026-10-26', 'fix/x') })).toBe(monday)
	})

	it('leaves the prefix byte-identical when plan mode toggles and the plan-mode reminder carries the file doctrine', () => {
		const planFacts = { planPath: '/tmp/plan.md' }
		const auto = fromFacts(planFacts, { permissionMode: 'auto', planInReminders: true })
		const plan = fromFacts(planFacts, { permissionMode: 'plan', planInReminders: true })
		expect(plan).toBe(auto)
		expect(plan).not.toContain(NAMZU_PLAN_FILE_DOCTRINE)
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
