import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { PromptContributionRegistry, skillsContribution } from '../../../prompt/contributions.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { AgentPersona } from '../../../types/persona/index.js'
import type { ProjectId } from '../../../types/session/ids.js'
import type { Skill } from '../../../types/skills/index.js'
import { PromptCache, type PromptCacheInput } from '../prompt-cache.js'
import { PromptBuilder } from '../prompt.js'

const cache = () =>
	new PromptCache({
		projectId: '8d8cdcf3-4c2c-484c-b208-54dcd1964be4' as ProjectId,
		agentId: 'agent-1',
	})

describe.each(['full', 'segmented'] as const)('%s prompt cache', (mode) => {
	const read = (c: PromptCache, input: PromptCacheInput) =>
		mode === 'segmented' ? c.getSystemPromptSegmented(input).static : c.getSystemPrompt(input)

	it.each(['replace', 'fresh registry'] as const)(
		'uses the new text when the same static id is reused through %s',
		(change) => {
			const c = cache()
			const contributions = new PromptContributionRegistry()
			const firstRender = vi.fn(() => 'FIRST INSTRUCTIONS')
			contributions.register({ id: 'instructions', placement: 'static', render: firstRender })
			const input = { systemPrompt: 'be brief', tools: new ToolRegistry(), contributions }
			expect(read(c, input)).toContain('FIRST INSTRUCTIONS')

			const next = change === 'replace' ? contributions : new PromptContributionRegistry()
			const nextRender = vi.fn(() => 'SECOND INSTRUCTIONS')
			if (change === 'replace') {
				next.replace({ id: 'instructions', placement: 'static', render: nextRender })
			} else {
				next.register({ id: 'instructions', placement: 'static', render: nextRender })
			}
			const after = read(c, { ...input, contributions: next })

			expect(after).toContain('be brief')
			expect(after).toContain('SECOND INSTRUCTIONS')
			expect(after).not.toContain('FIRST INSTRUCTIONS')
			expect(firstRender).toHaveBeenCalledTimes(1)
			expect(nextRender).toHaveBeenCalledTimes(1)
		},
	)

	it('removes a static instruction when its renderer becomes empty', () => {
		const c = cache()
		const contributions = new PromptContributionRegistry()
		contributions.register({ id: 'instructions', placement: 'static', render: () => 'OLD TEXT' })
		const input = { systemPrompt: 'be brief', tools: new ToolRegistry(), contributions }
		expect(read(c, input)).toContain('OLD TEXT')

		contributions.replace({ id: 'instructions', placement: 'static', render: () => null })

		expect(read(c, input)).toBe('be brief')
	})

	it('refreshes changed persona and skill content without renaming them', () => {
		const c = cache()
		const persona: AgentPersona = {
			identity: { role: 'Analyst', description: 'reads things' },
			output: { format: 'FIRST FORMAT' },
			sessionContext: 'FIRST SESSION',
		}
		const skill = {
			metadata: { name: 'reconcile', description: 'reconcile two ledgers' },
			body: 'FIRST SKILL',
			dirPath: '/skills/reconcile',
		} as Skill
		const input = { basePrompt: 'BASE', persona, skills: [skill], tools: new ToolRegistry() }
		const before = read(c, input)
		const updated = {
			...input,
			persona: {
				...persona,
				output: { format: 'SECOND FORMAT' },
				sessionContext: 'SECOND SESSION',
			},
			skills: [{ ...skill, body: 'SECOND SKILL' }],
		}
		const after = read(c, updated)

		expect(before).toContain('FIRST FORMAT')
		expect(before).toContain('FIRST SKILL')
		expect(after).toContain('BASE')
		expect(after).toContain('Analyst')
		expect(after).toContain('SECOND FORMAT')
		expect(after).toContain('SECOND SKILL')
		expect(after).not.toContain('FIRST FORMAT')
		expect(after).not.toContain('FIRST SKILL')
		if (mode === 'full') {
			expect(after).toContain('SECOND SESSION')
			expect(after).not.toContain('FIRST SESSION')
		} else {
			expect(after).not.toContain('SECOND SESSION')
			expect(c.getSystemPromptSegmented(updated).dynamic).toContain('SECOND SESSION')
		}
	})

	it('renders each system contribution once per call and leaves turn rendering to the loop', () => {
		const c = cache()
		const staticRender = vi.fn(() => 'STATIC TEXT')
		let dynamicText = 'FIRST DYNAMIC'
		const dynamicRender = vi.fn(() => dynamicText)
		const turnRender = vi.fn(() => 'TURN TEXT')
		const contributions = new PromptContributionRegistry()
		contributions.register({ id: 'static', placement: 'static', render: staticRender })
		contributions.register({ id: 'dynamic', placement: 'dynamic', render: dynamicRender })
		contributions.register({ id: 'turn', placement: 'turn', render: turnRender })
		const input = { systemPrompt: 'be brief', tools: new ToolRegistry(), contributions }
		const whole = () =>
			mode === 'full'
				? c.getSystemPrompt(input)
				: Object.values(c.getSystemPromptSegmented(input)).join('\n')
		const first = whole()
		dynamicText = 'SECOND DYNAMIC'
		const second = whole()

		expect(first).toContain('FIRST DYNAMIC')
		expect(second).toContain('SECOND DYNAMIC')
		expect(second).not.toContain('FIRST DYNAMIC')
		expect(second).toContain('STATIC TEXT')
		expect(second).not.toContain('TURN TEXT')
		expect(staticRender).toHaveBeenCalledTimes(2)
		expect(dynamicRender).toHaveBeenCalledTimes(2)
		expect(turnRender).not.toHaveBeenCalled()
	})
})

describe('prompt cache options', () => {
	it('honors a different context level when reusing the same cache', () => {
		const c = cache()
		const input = { basePrompt: 'BASE', systemPrompt: 'be brief', tools: new ToolRegistry() }
		expect(c.getSystemPromptSegmented(input, 'full').static).toContain('BASE')
		expect(c.getSystemPromptSegmented(input, 'minimal').static).toBe('be brief')
		expect(c.getSystemPromptSegmented(input, 'full').static).toContain('BASE')
	})

	it('uses current render options while preserving skills and environment composition', () => {
		const c = cache()
		const tools = new ToolRegistry()
		tools.register(
			['first-tool', 'second-tool'].map((name) => ({
				name,
				description: `Use ${name}`,
				inputSchema: z.object({}),
				execute: async () => ({ success: true, output: '' }),
			})),
		)
		const contributions = new PromptContributionRegistry()
		contributions.register(skillsContribution)
		contributions.register({
			id: 'run-context',
			placement: 'static',
			render: ({ workingDirectory, runtimeContext, allowedTools }) =>
				`${workingDirectory} ${runtimeContext?.label} ${allowedTools?.join(',')}`,
		})
		const input = {
			basePrompt: 'BASE',
			systemPrompt: 'be brief',
			tools,
			contributions,
			skills: [
				{
					metadata: { name: 'reconcile', description: 'reconcile two ledgers' },
					body: 'SKILL BODY',
					dirPath: '/skills/reconcile',
				} as Skill,
			],
			runtimeContext: { label: 'FIRST RUNTIME' },
			allowedTools: ['first-tool'],
		}
		const first = c.getSystemPromptSegmented(input, 'full', '/first')
		const updated = {
			...input,
			runtimeContext: { label: 'SECOND RUNTIME' },
			allowedTools: ['second-tool'],
		}
		const second = c.getSystemPromptSegmented(updated, 'full', '/second')

		expect(first.static).toContain('/first FIRST RUNTIME first-tool')
		expect(second.static).toContain('/second SECOND RUNTIME second-tool')
		expect(second.static).not.toContain('FIRST RUNTIME')
		expect(second.static).toContain('BASE')
		expect(second.static).toContain('be brief')
		expect(second.static.split('SKILL BODY')).toHaveLength(2)
		expect(second.dynamic).toContain('Working directory: /second')
		expect(second.dynamic).toContain('Runtime: SECOND RUNTIME')
		expect(second).toEqual(new PromptBuilder(updated).buildSegmented('full', '/second'))
		expect(c.getSystemPromptSegmented(updated, 'full', '/second')).toEqual(second)
	})

	it('reports replaced text through needsRebuild without changing the cached hash', () => {
		const c = cache()
		const contributions = new PromptContributionRegistry()
		contributions.register({ id: 'instructions', placement: 'static', render: () => 'OLD TEXT' })
		const input = { tools: new ToolRegistry(), contributions }
		c.getSystemPrompt(input)
		const previousHash = c.configHash
		expect(c.needsRebuild(input)).toBe(false)

		contributions.replace({ id: 'instructions', placement: 'static', render: () => 'NEW TEXT' })
		expect(c.needsRebuild(input)).toBe(true)
		expect(c.configHash).toBe(previousHash)
		expect(c.getSystemPrompt(input)).toBe('NEW TEXT')
		expect(c.configHash).not.toBe(previousHash)
		expect(c.needsRebuild(input)).toBe(false)
	})
})
