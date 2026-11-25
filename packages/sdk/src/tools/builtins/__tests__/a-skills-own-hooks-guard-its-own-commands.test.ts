import { describe, expect, it } from 'vitest'

import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type {
	SkillHooksHandle,
	SkillHooksPlan,
	SkillRegistryRef,
	ToolContext,
	ToolDispatchOptions,
	ToolResult,
} from '../../../types/tool/index.js'
import { createSkillTool } from '../skill.js'

/**
 * A skill's own hooks guard its own load-time commands, and a skill whose
 * hooks could not be read gets no pre-approval from `allowed-tools` on any
 * path that loads it: inline or delegated.
 */

const HOOKS = 'hooks:\n  PreToolUse: []'

function registry(extra: { context?: 'fork'; body?: string }): SkillRegistryRef {
	return {
		names: () => ['guarded'],
		async load(name) {
			if (name !== 'guarded') return undefined
			return {
				skill: {
					metadata: {
						name: 'guarded',
						description: 'd',
						allowedTools: 'Bash',
						hooksSource: HOOKS,
						...(extra.context ? { context: extra.context } : {}),
					},
					body: extra.body ?? 'Run: !`touch made`',
					dirPath: '/skills/guarded',
				},
			}
		},
	}
}

interface Order {
	readonly events: string[]
	readonly plan: NonNullable<SkillRegistryRef['prepareHooks']>
}

function order(parts: Partial<SkillHooksPlan> = {}): Order {
	const events: string[] = []
	return {
		events,
		plan: () => ({
			withholdGrants: false,
			attach: (): SkillHooksHandle => {
				events.push('attach')
				return { remove: () => events.push('remove') }
			},
			...parts,
		}),
	}
}

type Gate = 'allow' | 'review' | { deny: string }

function dispatchOf(
	events: string[],
	gate: Gate,
	agent?: (input: unknown) => ToolResult,
): NonNullable<ToolContext['dispatchTool']> {
	return async (name, input, options?: ToolDispatchOptions) => {
		if (name === 'Agent') {
			events.push('agent')
			return agent?.(input) ?? { success: true, output: 'report' }
		}
		const granted = gate === 'review' && options?.allow?.({ name, input }) === true
		if (typeof gate === 'object' || (gate === 'review' && !granted)) {
			events.push('refused')
			return {
				success: false,
				output: '',
				error: 'Error: Tool "bash" was not executed. Blocked by the authorization gate: no rule',
			}
		}
		events.push('command')
		return { success: true, output: 'STDOUT:\nok', data: { exitCode: 0 } }
	}
}

function contextOf(
	skills: SkillRegistryRef,
	dispatchTool: NonNullable<ToolContext['dispatchTool']>,
	extra: Partial<ToolContext> = {},
): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
		turnId: '651d7ad7-a79e-4783-85bb-5bcd9da09f20' as TurnId,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		skills,
		dispatchTool,
		...extra,
	}
}

const withAgent = {
	toolRegistry: {
		has: (name: string) => name === 'Agent',
		availability: () => 'active',
		searchDeferred: () => [],
	} as unknown as ToolContext['toolRegistry'],
}

describe('a skill’s own hooks and its load-time commands', () => {
	it('are attached before the first command runs', async () => {
		const seen = order()
		const result = await createSkillTool({ shell: {} }).execute(
			{ name: 'guarded' },
			contextOf({ ...registry({}), prepareHooks: seen.plan }, dispatchOf(seen.events, 'allow')),
		)
		expect(result.success).toBe(true)
		expect(seen.events).toEqual(['attach', 'command'])
	})

	it('come off again when a command fails the load', async () => {
		const seen = order()
		const result = await createSkillTool({ shell: {} }).execute(
			{ name: 'guarded' },
			contextOf(
				{ ...registry({}), prepareHooks: seen.plan },
				dispatchOf(seen.events, { deny: 'no' }),
			),
		)
		expect(result.success).toBe(false)
		expect(seen.events).toEqual(['attach', 'refused', 'remove'])
	})

	it('stay attached once the instructions are delivered', async () => {
		const seen = order()
		await createSkillTool({ shell: {} }).execute(
			{ name: 'guarded' },
			contextOf({ ...registry({}), prepareHooks: seen.plan }, dispatchOf(seen.events, 'allow')),
		)
		expect(seen.events).not.toContain('remove')
	})
})

describe('a delegated skill and its pre-approval', () => {
	it('pre-approves the skill’s commands when the host does not withhold it', async () => {
		const seen = order()
		const result = await createSkillTool({ shell: {} }).execute(
			{ name: 'guarded' },
			contextOf(
				{ ...registry({ context: 'fork' }), prepareHooks: seen.plan },
				dispatchOf(seen.events, 'review'),
				withAgent,
			),
		)
		expect(result.success).toBe(true)
		expect(seen.events).toEqual(['command', 'attach', 'agent', 'remove'])
	})

	it('withholds it exactly when the inline load does', async () => {
		const seen = order({ withholdGrants: true, notice: 'its guard could not be loaded' })
		const forked = await createSkillTool({ shell: {} }).execute(
			{ name: 'guarded' },
			contextOf(
				{ ...registry({ context: 'fork' }), prepareHooks: seen.plan },
				dispatchOf(seen.events, 'review'),
				withAgent,
			),
		)
		expect(forked.success).toBe(false)
		expect(seen.events).toEqual(['refused'])

		const inlineEvents: string[] = []
		const inline = await createSkillTool({ shell: {} }).execute(
			{ name: 'guarded' },
			contextOf(
				{ ...registry({}), prepareHooks: order({ withholdGrants: true }).plan },
				dispatchOf(inlineEvents, 'review'),
			),
		)
		expect(inline.success).toBe(false)
		expect(inlineEvents).toEqual(['refused'])
	})
})
