import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { TokenBudget } from '../../../run/token-budget.js'
import { createUserMessage } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const directories: string[] = []
afterEach(async () => {
	await removeTempDirs(directories.splice(0))
})
const usage = (tokens: number) => ({
	promptTokens: tokens,
	completionTokens: 0,
	totalTokens: tokens,
})

async function fixture() {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-advisory-ledger-'))
	directories.push(workingDirectory)
	const runId = generateRunId()
	const budget = TokenBudget.create(1_000, runId)
	const tools = new ToolRegistry()
	tools.register({
		name: 'echo',
		description: 'Echo.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'ready' }),
	})
	return {
		workingDirectory,
		runId,
		budget,
		tools,
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		agentId: 'advisory-budget',
		agentName: 'Advisory budget',
		messages: [createUserMessage('Consult and finish.')],
		retry: false as const,
		runConfig: { model: 'mock', tokenBudget: 1_000, timeoutMs: 5_000, maxIterations: 4 },
	}
}

describe('advisory calls debit the same token authority as the parent query', () => {
	it.each(['trigger', 'tool'] as const)(
		'charges a %s consultation before the next parent call',
		async (mode) => {
			const params = await fixture()
			const advisor = new MockLLMProvider({ turns: [{ text: 'Advice.', usage: usage(600) }] })
			const main = new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							mode === 'trigger'
								? { name: 'echo', args: {} }
								: {
										name: 'consult_advisor',
										args: { advisor_id: 'reviewer', question: 'Review.' },
									},
						],
						usage: usage(200),
					},
					{ text: 'Done.', usage: usage(100) },
				],
			})
			const run = await drainQuery({
				...params,
				provider: main,
				advisory: {
					advisors: [{ id: 'reviewer', name: 'Reviewer', model: 'mock', provider: advisor }],
					budget: { maxCallsPerRun: 1 },
					enableAgentTool: mode === 'tool',
					...(mode === 'trigger'
						? {
								triggers: [
									{
										id: 'each-turn',
										condition: { type: 'on_iteration' as const, everyN: 1 },
										advisorId: 'reviewer',
									},
								],
							}
						: {}),
				},
			})
			expect(main.requests).toHaveLength(2)
			expect(advisor.requests).toHaveLength(1)
			expect(run.tokenUsage.totalTokens).toBe(900)
			expect(run.budget).toMatchObject({
				ownTokens: 900,
				treeTokens: 900,
				poisoned: false,
				inFlightRequests: 0,
			})
			expect(params.budget.ownTokens).toBe(900)
		},
	)

	it.each([1, 2])(
		'serializes same-turn consultations before rechecking a %s-call quota',
		async (quota) => {
			const params = await fixture()
			const advisor = new MockLLMProvider({
				turns: [
					{ text: 'First.', usage: usage(100) },
					{ text: 'Second.', usage: usage(100) },
				],
			})
			const main = new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{ name: 'consult_advisor', args: { question: 'One?' } },
							{ name: 'consult_advisor', args: { question: 'Two?' } },
						],
						usage: usage(100),
					},
					{ text: 'Done.', usage: usage(100) },
				],
			})
			const run = await drainQuery({
				...params,
				provider: main,
				advisory: {
					advisors: [{ id: 'reviewer', name: 'Reviewer', model: 'mock', provider: advisor }],
					enableAgentTool: true,
					budget: { maxCallsPerRun: quota },
				},
			})
			expect(advisor.requests).toHaveLength(quota)
			expect(run.budget).toMatchObject({
				ownTokens: 200 + quota * 100,
				treeTokens: 200 + quota * 100,
				poisoned: false,
			})
			const results = run.messages.filter((message) => message.role === 'tool')
			expect(results).toHaveLength(2)
			expect(results.filter((message) => message.isError)).toHaveLength(quota === 1 ? 1 : 0)
		},
	)
})
