import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { AgentRunConfig, RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs.splice(0))
})

async function run(turns: MockTurn[], limits: Partial<AgentRunConfig>) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-hard-stop-'))
	dirs.push(workingDirectory)
	const provider = new MockLLMProvider({ turns })
	const tools = new ToolRegistry()
	tools.register({
		name: 'observe',
		description: 'Return observed work',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'Observed work remains available.' }),
	})
	const events: RunEvent[] = []
	const result = await drainQuery(
		{
			provider,
			tools,
			retry: false,
			pricing: { inputCostPer1M: 1, outputCostPer1M: 1 },
			runConfig: {
				model: 'mock',
				timeoutMs: 30_000,
				tokenBudget: 10_000,
				maxIterations: 5,
				...limits,
			},
			agentId: 'budget-check',
			agentName: 'Budget check',
			messages: [createUserMessage('Keep observing until finished.')],
			workingDirectory,
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
		},
		(event) => {
			events.push(event)
		},
	)
	return { result, provider, events }
}

const usage = { promptTokens: 100, completionTokens: 100, totalTokens: 200 }
const toolTurn: MockTurn = { toolCalls: [{ id: 'observe-1', name: 'observe', args: {} }], usage }

describe('a hard stop starts no closing model request', () => {
	it('makes zero requests when no iterations were granted', async () => {
		const { result, provider } = await run([{ text: 'should not run' }], { maxIterations: 0 })
		expect(provider.requests).toHaveLength(0)
		expect(result.stopReason).toBe('max_iterations')
		expect(result.tokenUsage.totalTokens).toBe(0)
	})

	it.each([
		{ reason: 'max_iterations', limits: { maxIterations: 1 } },
		{ reason: 'token_budget', limits: { tokenBudget: 200 } },
		{ reason: 'cost_limit', limits: { costLimitUsd: 0.0002 } },
	] as const)('preserves work and %s without a post-cap request', async ({ reason, limits }) => {
		const { result, provider, events } = await run(
			[toolTurn, { text: 'extra spend', usage }],
			limits,
		)
		expect(provider.requests).toHaveLength(1)
		expect(result.stopReason).toBe(reason)
		expect(result.tokenUsage.totalTokens).toBe(200)
		expect(result.costInfo.totalCost).toBeCloseTo(0.0002)
		expect(
			result.messages.some(
				(message) =>
					message.role === 'tool' &&
					String(message.content).includes('Observed work remains available.'),
			),
		).toBe(true)
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'run_completed', stopReason: reason }),
		)
	})

	it.each([
		{ reason: 'max_iterations', limits: { maxIterations: 1 } },
		{ reason: 'token_budget', limits: { tokenBudget: 200 } },
		{ reason: 'cost_limit', limits: { costLimitUsd: 0.0002 } },
	] as const)(
		'does not label an exhausted empty response end_turn: %s',
		async ({ reason, limits }) => {
			const { result, provider, events } = await run(
				[
					{ text: '', usage },
					{ text: 'extra spend', usage },
				],
				limits,
			)
			expect(provider.requests).toHaveLength(1)
			expect(result.stopReason).toBe(reason)
			expect(result.tokenUsage.totalTokens).toBe(200)
			expect(events).toContainEqual(
				expect.objectContaining({ type: 'run_completed', stopReason: reason }),
			)
		},
	)

	it('can still close at the warning threshold while budget remains', async () => {
		const { result, provider } = await run(
			[
				{ ...toolTurn, usage: { promptTokens: 450, completionTokens: 450, totalTokens: 900 } },
				{
					text: 'Work summarized.',
					usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
				},
			],
			{ tokenBudget: 1_000, maxIterations: 2 },
		)
		expect(provider.requests).toHaveLength(2)
		expect(provider.requests[1]?.toolChoice).toBe('none')
		expect(result.result).toBe('Work summarized.')
		expect(result.tokenUsage.totalTokens).toBe(940)
	})

	it('keeps zero token and cost limits unlimited', async () => {
		const { result, provider } = await run([toolTurn, { text: 'done', usage }], {
			tokenBudget: 0,
			costLimitUsd: 0,
			maxIterations: 2,
		})
		expect(provider.requests).toHaveLength(2)
		expect(result.stopReason).toBe('end_turn')
	})
})
