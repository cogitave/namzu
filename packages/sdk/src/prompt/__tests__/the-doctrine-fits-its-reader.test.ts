/**
 * The doctrine tells the model which tools to use. A rule about a tool the
 * reader does not have is an instruction to fail, so the delegation rules
 * must be separable, and every tool the working rules name must be one the
 * kernel actually ships.
 */

import { describe, expect, it } from 'vitest'

import { PromptBuilder } from '../../runtime/query/prompt.js'
import { ToolManager } from '../../toolsets/manager.js'
import {
	CODING_AGENT_DELEGATION_DOCTRINE,
	CODING_AGENT_DOCTRINE_CONTRIBUTION_ID,
	CODING_AGENT_HYPERMODE_DOCTRINE,
	CODING_AGENT_ORCHESTRATE_DOCTRINE,
	CODING_AGENT_WORKING_DOCTRINE,
	PLAN_MODE_DOCTRINE,
	codingAgentDoctrineContribution,
} from '../coding-agent-doctrine.js'
import { PromptContributionRegistry } from '../contributions.js'

describe('the coding-agent doctrine', () => {
	it('names only builtin tools in the rules every agent receives', () => {
		const named = new Set(
			[...CODING_AGENT_WORKING_DOCTRINE.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]),
		)
		for (const tool of ['read', 'edit', 'write', 'bash', 'grep', 'glob']) {
			expect(named.has(tool)).toBe(true)
		}
		expect(named.has('task_create')).toBe(false)
		expect(named.has('Agent')).toBe(false)
	})

	it('forbids changing git config or other persistent settings without asking', () => {
		// A live session set `git config user.name`/`user.email` on its own
		// when a commit failed for want of an identity.
		expect(CODING_AGENT_WORKING_DOCTRINE).toContain(
			'Never change git configuration or other persistent settings without asking',
		)
		for (const named of ['`user.name`', '`user.email`', 'hooks', 'remotes', '`git config`'])
			expect(CODING_AGENT_WORKING_DOCTRINE).toContain(named)
		expect(CODING_AGENT_WORKING_DOCTRINE).toContain(
			'If a commit fails because no identity is set, stop and tell the user the command to set one; do not invent one.',
		)
	})

	it('keeps the delegation rules out of a sub-agent prompt on request', () => {
		const parent = codingAgentDoctrineContribution().render({})
		const child = codingAgentDoctrineContribution({ delegation: false }).render({})
		expect(parent).toContain(CODING_AGENT_DELEGATION_DOCTRINE)
		expect(child).toBe(CODING_AGENT_WORKING_DOCTRINE)
		expect(child).not.toContain('task_create')
		expect(child).not.toContain('`Agent`')
	})

	it('lands in the cached prefix, after the host identity block', () => {
		const registry = new PromptContributionRegistry()
		registry.register(codingAgentDoctrineContribution())
		const builder = new PromptBuilder({
			systemPrompt: 'You are the host.',
			tools: new ToolManager({ toolsets: [], messages: () => [] }),
			contributions: registry,
		})
		const segments = builder.buildSegmented('full', '/tmp/project')
		expect(segments.static.indexOf('You are the host.')).toBeLessThan(
			segments.static.indexOf('## How you work'),
		)
		expect(segments.dynamic).not.toContain('## How you work')
	})

	it('is one contribution with a namespaced id, and the plan-mode text stands alone', () => {
		expect(CODING_AGENT_DOCTRINE_CONTRIBUTION_ID).toMatch(/^namzu\./)
		expect(codingAgentDoctrineContribution().placement).toBe('static')
		expect(PLAN_MODE_DOCTRINE).toContain('plan mode')
		expect(CODING_AGENT_WORKING_DOCTRINE).not.toContain('plan mode')
	})

	it('strengthens delegation guidance only when hypermode is on', () => {
		const today = `${CODING_AGENT_WORKING_DOCTRINE}\n\n${CODING_AGENT_DELEGATION_DOCTRINE}`
		const off = codingAgentDoctrineContribution().render({})
		const offExplicit = codingAgentDoctrineContribution({ hypermode: false }).render({})
		const on = codingAgentDoctrineContribution({ hypermode: true }).render({})
		// Mode-off output must stay byte-identical to what this contribution
		// rendered before the flag existed — a changed default here would be a
		// `major`, not a `minor`, under this repo's own SemVer rule.
		expect(off).toBe(today)
		expect(offExplicit).toBe(today)
		expect(on).toContain(CODING_AGENT_DELEGATION_DOCTRINE)
		expect(on).toContain(CODING_AGENT_HYPERMODE_DOCTRINE)
		expect(on).not.toBe(off)
		// The text names the mode by the name the operator sees.
		expect(CODING_AGENT_HYPERMODE_DOCTRINE).toMatch(
			/^### Hypermode\nThis session has hypermode on:/,
		)
	})

	it('still honours the deprecated orchestrate name, with the same text', () => {
		expect(CODING_AGENT_ORCHESTRATE_DOCTRINE).toBe(CODING_AGENT_HYPERMODE_DOCTRINE)
		expect(codingAgentDoctrineContribution({ orchestrate: true }).render({})).toBe(
			codingAgentDoctrineContribution({ hypermode: true }).render({}),
		)
	})

	it('asks for one phase to be launched in one response, never one agent at a time', () => {
		// A model given "two agents in parallel" and the mode on still
		// launched them one response apart; the doctrine now says so outright.
		expect(CODING_AGENT_HYPERMODE_DOCTRINE).toContain(
			'Agents in the same phase are launched in the same response',
		)
		expect(CODING_AGENT_HYPERMODE_DOCTRINE).toContain('never started one agent at a time')
		// The delegation text without the mode is untouched by this sentence.
		expect(CODING_AGENT_DELEGATION_DOCTRINE).not.toContain('same phase')
	})

	it('never appends the hypermode text to a sub-agent prompt with delegation off', () => {
		for (const flag of [{ hypermode: true }, { orchestrate: true }]) {
			const child = codingAgentDoctrineContribution({ delegation: false, ...flag }).render({})
			expect(child).toBe(CODING_AGENT_WORKING_DOCTRINE)
			expect(child).not.toContain(CODING_AGENT_HYPERMODE_DOCTRINE)
		}
	})
})
