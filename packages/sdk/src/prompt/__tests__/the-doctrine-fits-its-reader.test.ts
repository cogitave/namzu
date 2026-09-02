/**
 * The doctrine tells the model which tools to use. A rule about a tool the
 * reader does not have is an instruction to fail, so the delegation rules
 * must be separable, and every tool the working rules name must be one the
 * kernel actually ships.
 */

import { describe, expect, it } from 'vitest'

import { ToolRegistry } from '../../registry/tool/execute.js'
import { PromptBuilder } from '../../runtime/query/prompt.js'
import {
	CODING_AGENT_DELEGATION_DOCTRINE,
	CODING_AGENT_DOCTRINE_CONTRIBUTION_ID,
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
			tools: new ToolRegistry(),
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
})
