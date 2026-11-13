import { describe, expect, it } from 'vitest'

import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type {
	SkillHooksHandle,
	SkillHooksOptions,
	SkillHooksPlan,
	SkillRegistryRef,
	ToolContext,
} from '../../../types/tool/index.js'
import { SkillTool } from '../skill.js'

/**
 * A skill's front matter may carry hooks. The kernel does not read them: the
 * host that runs them answers, and a skill written to run its commands under
 * its own guard must not run them unguarded and pre-approved.
 */

const HOOKS = 'hooks:\n  PreToolUse: []'

function registry(
	extra: { context?: 'fork'; hooksSource?: string; background?: boolean },
	prepare?: SkillRegistryRef['prepareHooks'],
): SkillRegistryRef {
	return {
		names: () => ['guarded'],
		async load(name) {
			if (name !== 'guarded') return undefined
			return {
				skill: {
					metadata: {
						name: 'guarded',
						description: 'd',
						allowedTools: 'bash',
						...(extra.context ? { context: extra.context } : {}),
						...(extra.background !== undefined ? { background: extra.background } : {}),
						...(extra.hooksSource !== undefined ? { hooksSource: extra.hooksSource } : {}),
					},
					body: 'Run commands.',
					dirPath: '/skills/guarded',
				},
			}
		},
		...(prepare ? { prepareHooks: prepare } : {}),
	}
}

interface Seen {
	asked: { name: string; dirPath?: string; hooksSource: string; options: SkillHooksOptions }[]
	committed: string[]
	attached: number
	removed: number
}

function plan(seen: Seen, parts: Partial<SkillHooksPlan> = {}): SkillRegistryRef['prepareHooks'] {
	return (skill, options) => {
		seen.asked.push({ ...skill, options })
		return {
			withholdGrants: false,
			attach: (): SkillHooksHandle => {
				seen.attached += 1
				return {
					remove: () => {
						seen.removed += 1
					},
				}
			},
			...parts,
		}
	}
}

function context(
	skills: SkillRegistryRef,
	seen: Seen,
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
		grantSkillTools: (grant) => ({
			granted: [...grant.allowedTools],
			ignored: [],
			commit: () => {
				seen.committed.push(grant.skill)
			},
		}),
		...extra,
	}
}

const fresh = (): Seen => ({ asked: [], committed: [], attached: 0, removed: 0 })

describe('a skill that carries hooks', () => {
	it('is read by the host, which says what it needs, and attaches only after the instructions are delivered', async () => {
		const seen = fresh()
		const result = await SkillTool.execute(
			{ name: 'guarded' },
			context(
				registry({ hooksSource: HOOKS }, plan(seen, { notice: 'its hooks are attached' })),
				seen,
			),
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('[its hooks are attached]')
		expect(result.output).toContain('Pre-approved for the rest of this turn: bash')
		expect(seen.asked).toEqual([
			{
				name: 'guarded',
				dirPath: '/skills/guarded',
				hooksSource: HOOKS,
				options: { forked: false, sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' },
			},
		])
		expect(seen.attached).toBe(1)
		expect(seen.committed).toEqual(['guarded'])
	})

	it('loads with none of its pre-approval when the host withholds it, and says why', async () => {
		const seen = fresh()
		const result = await SkillTool.execute(
			{ name: 'guarded' },
			context(
				registry(
					{ hooksSource: HOOKS },
					plan(seen, { withholdGrants: true, notice: 'its guard could not be loaded' }),
				),
				seen,
			),
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('Run commands.')
		expect(result.output).toContain('[its guard could not be loaded]')
		expect(result.output).not.toContain('Pre-approved')
		expect(seen.committed).toEqual([])
		expect(result.data).not.toHaveProperty('granted')
	})

	it('withholds the pre-approval when the registry cannot read hooks at all', async () => {
		const seen = fresh()
		const result = await SkillTool.execute(
			{ name: 'guarded' },
			context(registry({ hooksSource: HOOKS }), seen),
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('carries hooks, but this session cannot run a skill')
		expect(result.output).not.toContain('Pre-approved')
		expect(seen.committed).toEqual([])
	})

	it('does not ask the host about a skill that carries no hooks', async () => {
		const seen = fresh()
		const result = await SkillTool.execute(
			{ name: 'guarded' },
			context(registry({}, plan(seen)), seen),
		)
		expect(result.output).toContain('Pre-approved')
		expect(seen.asked).toEqual([])
		expect(seen.attached).toBe(0)
	})

	it('attaches nothing when the instructions could not be delivered', async () => {
		const seen = fresh()
		const result = await SkillTool.execute(
			{ name: 'guarded' },
			context(registry({ hooksSource: HOOKS }, plan(seen)), seen, { maxToolOutputChars: 5 }),
		)
		expect(result.success).toBe(false)
		expect(seen.attached).toBe(0)
	})
})

describe('a forked skill that carries hooks', () => {
	function forkContext(seen: Seen, outcome: { success: boolean } | Error, background = false) {
		const skills = registry(
			{ context: 'fork', hooksSource: HOOKS, background },
			plan(seen, { notice: 'its hooks apply to the delegated agent' }),
		)
		return context(skills, seen, {
			toolRegistry: {
				has: (name: string) => name === 'Agent',
				availability: () => 'active',
				searchDeferred: () => [],
			} as unknown as ToolContext['toolRegistry'],
			dispatchTool: async () => {
				// The hooks are live while the delegated agent runs.
				expect(seen.attached).toBe(1)
				expect(seen.removed).toBe(0)
				if (outcome instanceof Error) throw outcome
				return { success: outcome.success, output: 'the report' }
			},
		})
	}

	it('attaches the hooks for the agent’s run and takes them off when it is over', async () => {
		const seen = fresh()
		const result = await SkillTool.execute(
			{ name: 'guarded' },
			forkContext(seen, { success: true }),
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('[its hooks apply to the delegated agent]')
		expect(seen.asked[0]?.options.forked).toBe(true)
		expect(seen.removed).toBe(1)
		// The skill's pre-approval is not a thing a delegated agent run gets.
		expect(seen.committed).toEqual([])
	})

	it('takes them off when the delegation throws', async () => {
		const seen = fresh()
		const result = await SkillTool.execute(
			{ name: 'guarded' },
			forkContext(seen, new Error('no agent')),
		)
		expect(result.success).toBe(false)
		expect(seen.removed).toBe(1)
	})

	it('leaves a background agent’s hooks to the host, which ends them when the agent ends', async () => {
		const seen = fresh()
		await SkillTool.execute({ name: 'guarded' }, forkContext(seen, { success: true }, true))
		expect(seen.attached).toBe(1)
		expect(seen.removed).toBe(0)
	})

	it('takes them off at once when the background agent could not be started', async () => {
		const seen = fresh()
		await SkillTool.execute({ name: 'guarded' }, forkContext(seen, { success: false }, true))
		expect(seen.removed).toBe(1)
	})
})
