import { describe, expect, it } from 'vitest'

import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { SkillRegistryRef, ToolContext } from '../../../types/tool/index.js'
import { SkillTool } from '../skill.js'

/**
 * A skill that sets `context: fork` is handed to the turn's delegation tool
 * instead of being loaded into the conversation.
 */

type Meta = NonNullable<Awaited<ReturnType<SkillRegistryRef['load']>>>['skill']['metadata']

function registry(extra: Partial<Meta>): SkillRegistryRef {
	return {
		names: () => ['survey'],
		async load(name) {
			if (name !== 'survey') return undefined
			return {
				skill: {
					metadata: { name: 'survey', description: 'a survey', ...extra },
					body: 'Survey the repository.',
				},
			}
		},
	}
}

interface Dispatch {
	name: string
	input: Record<string, unknown>
}

function contextFor(
	skills: SkillRegistryRef,
	options: { tools?: readonly string[]; dispatches?: Dispatch[] } = {},
): ToolContext {
	const tools = options.tools ?? []
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
		turnId: '651d7ad7-a79e-4783-85bb-5bcd9da09f20' as TurnId,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		skills,
		toolRegistry: {
			has: (name: string) => tools.includes(name),
			availability: () => 'active',
			searchDeferred: () => [],
		} as unknown as ToolContext['toolRegistry'],
		dispatchTool: async (name, input) => {
			options.dispatches?.push({ name, input: input as Record<string, unknown> })
			return { success: true, output: 'the report' }
		},
	}
}

describe('a forked skill runs as a delegated agent', () => {
	it('sends its instructions and arguments to the delegation tool and returns the report', async () => {
		const dispatches: Dispatch[] = []
		const result = await SkillTool.execute(
			{ name: 'survey', args: 'the sandbox package' },
			contextFor(
				registry({
					context: 'fork',
					agent: 'explore',
					model: 'small-model',
					effort: 'high',
					background: false,
				}),
				{ tools: ['Agent'], dispatches },
			),
		)

		expect(result.success).toBe(true)
		expect(result.output).toBe('the report')
		expect(result.data).toMatchObject({ skill: 'survey', forked: true })
		expect(dispatches).toEqual([
			{
				name: 'Agent',
				input: {
					description: 'Skill survey',
					prompt: 'Arguments: the sandbox package\n\nSurvey the repository.',
					subagent_type: 'explore',
					model: 'small-model',
					effort: 'high',
					run_in_background: false,
				},
			},
		])
	})

	it.each(['low', 'none'] as const)(
		'passes effort %s without inventing a model',
		async (effort) => {
			const dispatches: Dispatch[] = []
			await SkillTool.execute(
				{ name: 'survey' },
				contextFor(registry({ context: 'fork', effort }), { tools: ['Agent'], dispatches }),
			)
			expect(dispatches).toEqual([
				{
					name: 'Agent',
					input: {
						description: 'Skill survey',
						prompt: 'Survey the repository.',
						effort,
					},
				},
			])
		},
	)

	it('preserves a host refusal of effort-only selection instead of silently dropping effort', async () => {
		const dispatches: Dispatch[] = []
		const context = contextFor(registry({ context: 'fork', effort: 'high' }), {
			tools: ['Agent'],
		})
		const result = await SkillTool.execute(
			{ name: 'survey' },
			{
				...context,
				dispatchTool: async (name, input) => {
					dispatches.push({ name, input: input as Record<string, unknown> })
					return {
						success: false,
						output: '',
						error: 'Supply model when selecting a child provider or effort.',
					}
				},
			},
		)
		expect(dispatches[0]?.input.effort).toBe('high')
		expect(dispatches[0]?.input).not.toHaveProperty('model')
		expect(result.success).toBe(false)
		expect(result.error).toBe('Supply model when selecting a child provider or effort.')
	})

	it('hands back a refused delegation as the failure it was', async () => {
		const context = contextFor(registry({ context: 'fork' }), { tools: ['Agent'] })
		const refusing = {
			...context,
			dispatchTool: async () => ({ success: false, output: '', error: 'no such agent type' }),
		}
		const result = await SkillTool.execute({ name: 'survey' }, refusing)
		expect(result.success).toBe(false)
		expect(result.error).toBe('no such agent type')
	})

	it('loads inline, and says why, when the turn has no delegation tool', async () => {
		const dispatches: Dispatch[] = []
		const result = await SkillTool.execute(
			{ name: 'survey' },
			contextFor(registry({ context: 'fork' }), { tools: [], dispatches }),
		)
		expect(dispatches).toEqual([])
		expect(result.success).toBe(true)
		expect(result.output).toContain('this turn cannot delegate')
		expect(result.output).toContain('Survey the repository.')
	})

	it('loads inline when the host has Agent but no dispatch capability', async () => {
		const context = contextFor(registry({ context: 'fork', effort: 'high' }), {
			tools: ['Agent'],
		})
		const { dispatchTool: _dispatch, ...withoutDispatch } = context
		const result = await SkillTool.execute({ name: 'survey' }, withoutDispatch)
		expect(result.success).toBe(true)
		expect(result.output).toContain('this turn cannot delegate')
		expect(result.output).toContain('Survey the repository.')
	})

	it('does not turn inline model or effort metadata into a delegated run', async () => {
		const dispatches: Dispatch[] = []
		const result = await SkillTool.execute(
			{ name: 'survey' },
			contextFor(
				registry({ context: 'inline', model: 'small-model', effort: 'high', background: true }),
				{ tools: ['Agent'], dispatches },
			),
		)
		expect(dispatches).toEqual([])
		expect(result.success).toBe(true)
		expect(result.output).toBe('Survey the repository.')
	})

	it('does not delegate a skill that did not ask to', async () => {
		const dispatches: Dispatch[] = []
		const result = await SkillTool.execute(
			{ name: 'survey', args: 'the docs' },
			contextFor(registry({}), { tools: ['Agent'], dispatches }),
		)
		expect(dispatches).toEqual([])
		expect(result.output).toBe('Arguments: the docs\n\nSurvey the repository.')
	})
})
