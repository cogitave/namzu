import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { SkillTool } from '../../../tools/builtins/skill.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SkillRegistryRef, ToolContext } from '../../../types/tool/index.js'
import { drainQuery } from '../index.js'

let workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

const cursorFrom = (value: unknown): string | undefined =>
	/with name "[^"]+" and cursor "([^"]+)"/.exec(String(value))?.[1]

function lastToolOutput(
	messages: readonly { role: string; content?: unknown }[],
): string | undefined {
	return [...messages].reverse().find((message) => message.role === 'tool')?.content as
		| string
		| undefined
}

async function run(
	provider: MockLLMProvider,
	tools: ToolRegistry,
	skills: SkillRegistryRef,
	over: Record<string, unknown> = {},
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-skill-budget-'))
	workdirs.push(workingDirectory)
	return drainQuery({
		provider,
		tools,
		skillRegistry: skills,
		maxToolOutputChars: 420,
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 20,
			maxResponseTokens: 256,
		},
		agentId: 'agent_skill_budget',
		agentName: 'Skill Budget Agent',
		workingDirectory,
		sessionId: 'ses_skill_budget' as SessionId,
		topicId: 'top_skill_budget' as TopicId,
		projectId: 'prj_skill_budget' as ProjectId,
		tenantId: 'tnt_skill_budget' as TenantId,
		messages: [createUserMessage('load the long skill completely')],
		...over,
	})
}

describe('skill pages reach the provider through the real query executor', () => {
	it('delivers every page under the active result cap, including the middle', async () => {
		const middle = 'MIDDLE_SKILL_FACT_EXACT'
		const body = `${'a'.repeat(900)}${middle}${'z'.repeat(900)}`
		const skills: SkillRegistryRef = {
			load: async () => ({
				skill: { metadata: { name: 'long', description: 'long skill' }, body },
			}),
			names: () => ['long'],
		}
		const tools = new ToolRegistry()
		tools.register(SkillTool)
		const seenOutputs: string[] = []
		const provider = new MockLLMProvider({
			nextTurn(params, index): MockTurn {
				if (index === 0) return { toolCalls: [{ name: 'skill', args: { name: 'long' } }] }
				const output = lastToolOutput(params.messages)
				if (output !== undefined) seenOutputs.push(String(output))
				const cursor = cursorFrom(output)
				return cursor
					? { toolCalls: [{ name: 'skill', args: { name: 'long', cursor } }] }
					: { text: 'done' }
			},
		})

		const result = await run(provider, tools, skills)

		expect(result.status, JSON.stringify(result)).toBe('completed')
		expect(seenOutputs.length).toBeGreaterThan(1)
		for (const output of seenOutputs) {
			expect(output.length).toBeLessThanOrEqual(420)
			expect(output).not.toContain('characters omitted')
		}
		expect(seenOutputs.join('\n')).toContain(middle)
	})

	it('does not widen the next batch when an old cursor meets new policy', async () => {
		const current = {
			body: 'unchanged body '.repeat(120),
			allowedTools: 'read',
		}
		const skills: SkillRegistryRef = {
			load: async () => ({
				skill: {
					metadata: {
						name: 'mutable',
						description: 'mutable skill',
						allowedTools: current.allowedTools,
					},
					body: current.body,
				},
			}),
			names: () => ['mutable'],
		}
		const readContexts: Array<readonly string[] | undefined> = []
		const read = {
			name: 'read',
			description: 'read one thing',
			inputSchema: z.object({}),
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: vi.fn(async (_input: unknown, context: ToolContext) => {
				readContexts.push(context.allowedTools)
				return { success: true, output: 'read succeeded' }
			}),
		}
		const tools = new ToolRegistry()
		tools.register(SkillTool)
		tools.register(read)
		tools.register({
			...read,
			name: 'bash',
			execute: async () => ({ success: true, output: 'must stay unavailable' }),
		})
		let staleOutput = ''
		const provider = new MockLLMProvider({
			nextTurn(params, index): MockTurn {
				if (index === 0) return { toolCalls: [{ name: 'skill', args: { name: 'mutable' } }] }
				if (index === 1) {
					const cursor = cursorFrom(lastToolOutput(params.messages))
					if (!cursor) throw new Error('first page did not expose a cursor')
					current.allowedTools = 'bash'
					return { toolCalls: [{ name: 'skill', args: { name: 'mutable', cursor } }] }
				}
				if (index === 2) {
					staleOutput = String(lastToolOutput(params.messages))
					return { toolCalls: [{ name: 'read', args: {} }] }
				}
				return { text: 'done' }
			},
		})

		const result = await run(provider, tools, skills, {
			allowedTools: ['skill', 'read', 'bash'],
		})

		expect(result.status, JSON.stringify(result)).toBe('completed')
		expect(staleOutput).toMatch(/stale or invalid/)
		expect(read.execute).toHaveBeenCalledOnce()
		expect(readContexts[0]).toEqual(['skill', 'read'])
	})
})
