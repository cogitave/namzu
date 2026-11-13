import { describe, expect, it } from 'vitest'

import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type {
	SkillHooksRecordFact,
	SkillRegistryRef,
	ToolContext,
} from '../../../types/tool/index.js'
import { SkillTool } from '../skill.js'

/**
 * A skill whose hooks were attached to the conversation is written into the
 * conversation's record once its instructions were delivered, so a host that
 * continues the conversation later can attach them again. A host that does not
 * ask for it (`resumable`), a forked skill and a continuation page write
 * nothing, and a record that could not be written is said to the model.
 */

function registry(resumable: boolean | undefined, forked = false): SkillRegistryRef {
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
						hooksSource: 'hooks:\n  PreToolUse: []',
						...(forked ? { context: 'fork' as const } : {}),
					},
					body: `Run commands. ${'more instructions. '.repeat(400)}`,
					dirPath: '/skills/guarded',
				},
			}
		},
		prepareHooks: () => ({
			withholdGrants: true,
			...(resumable === undefined ? {} : { resumable }),
			attach: () => ({ remove: () => undefined }),
		}),
	}
}

function context(
	skills: SkillRegistryRef,
	kept: SkillHooksRecordFact[],
	write: ToolContext['recordSkillHooks'] | 'absent' = async (fact) => {
		kept.push(fact)
		return true
	},
): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
		turnId: '651d7ad7-a79e-4783-85bb-5bcd9da09f20' as TurnId,
		toolUseId: 'call_1',
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		skills,
		...(write === 'absent' ? {} : { recordSkillHooks: write }),
	}
}

describe('a skill whose hooks were attached', () => {
	it('is kept in the conversation with its folder, its call and whether its grants were withheld', async () => {
		const kept: SkillHooksRecordFact[] = []
		const result = await SkillTool.execute({ name: 'guarded' }, context(registry(true), kept))
		expect(result.success).toBe(true)
		expect(result.output).not.toContain('could not keep a record')
		expect(kept).toEqual([
			{
				skill: 'guarded',
				directory: '/skills/guarded',
				grantsWithheld: true,
				toolCallId: 'call_1',
			},
		])
	})

	it('is not kept when the host does not ask for it', async () => {
		for (const resumable of [undefined, false]) {
			const kept: SkillHooksRecordFact[] = []
			const result = await SkillTool.execute(
				{ name: 'guarded' },
				context(registry(resumable), kept),
			)
			expect(result.success).toBe(true)
			expect(kept).toEqual([])
			expect(result.output).not.toContain('could not keep a record')
		}
	})

	it('is not kept again on a continuation page of the same load', async () => {
		const kept: SkillHooksRecordFact[] = []
		const base = { ...context(registry(true), kept), maxToolOutputChars: 2_000 }
		const first = await SkillTool.execute({ name: 'guarded' }, base)
		expect(first.success).toBe(true)
		const cursor = (first.data as { nextCursor?: string }).nextCursor
		expect(cursor).toBeDefined()
		expect(kept).toHaveLength(1)
		const second = await SkillTool.execute({ name: 'guarded', cursor }, base)
		expect(second.success).toBe(true)
		expect(kept).toHaveLength(1)
	})

	it('tells the model when the record could not be written, never silently', async () => {
		for (const write of [
			async () => false,
			async () => Promise.reject(new Error('disk full')),
			'absent',
		] as const) {
			const result = await SkillTool.execute(
				{ name: 'guarded' },
				context(registry(true), [], write),
			)
			expect(result.success).toBe(true)
			expect(result.output).toContain('could not keep a record of this skill')
			expect(result.output).toContain('load the skill again')
		}
	})
})
