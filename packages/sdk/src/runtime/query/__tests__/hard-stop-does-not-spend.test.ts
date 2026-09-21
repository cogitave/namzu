import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { PromptContributionRegistry } from '../../../prompt/contributions.js'
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
import { type QueryParams, drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await removeTempDirs(dirs.splice(0))
})

async function run(
	turns: MockTurn[],
	limits: Partial<AgentRunConfig>,
	controls: Pick<
		QueryParams,
		| 'reviewAnswer'
		| 'onStepFinish'
		| 'signal'
		| 'structuredOutput'
		| 'workingMemoryProvider'
		| 'promptContributions'
	> = {},
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-hard-stop-'))
	dirs.push(workingDirectory)
	const provider = new MockLLMProvider({
		turns,
		...(controls.structuredOutput
			? {
					capabilities: {
						supportsTools: true,
						supportsStreaming: true,
						supportsFunctionCalling: true,
						supportsNativeStructuredOutput: true,
					},
				}
			: {}),
	})
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
			...controls,
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

it.each(['warning', 'empty'] as const)(
	'keeps evidence-aware closing guidance request-local after %s completion',
	async (mode) => {
		const { result, provider } = await run(
			[
				mode === 'warning'
					? { ...toolTurn, usage: { promptTokens: 475, completionTokens: 475, totalTokens: 950 } }
					: { text: '', usage },
				{ text: 'A partial observation is available; the task is unresolved.', usage },
			],
			{ tokenBudget: 1_000 },
		)
		expect(provider.requests).toHaveLength(2)
		expect(provider.requests[1]?.toolChoice).toBe('none')
		const closing = provider.requests[1]?.messages.filter(
			(message) =>
				message.role === 'user' &&
				message.source?.type === 'runtime-context' &&
				message.source.kind === 'limit-finalization',
		)
		expect(closing).toHaveLength(1)
		expect(closing?.[0]?.content).toContain('Attribute unverified statements to their source')
		expect(closing?.[0]?.content).toContain('If evidence is missing or conflicting')
		expect(closing?.[0]?.content).toContain('Do not claim unfinished work is complete')
		// The nudge applies to this request, not future resumed conversation history.
		expect(
			result.messages.some(
				(message) =>
					message.role === 'user' &&
					message.source?.type === 'runtime-context' &&
					message.source.kind === 'limit-finalization',
			),
		).toBe(false)
		expect(result.stopReason).toBe(mode === 'warning' ? 'token_budget' : 'end_turn')
	},
)

it.each(['warning', 'empty'] as const)(
	'puts the closing directive after every piece of request-only context on %s completion',
	async (mode) => {
		// Volatile context rides the request's tail: the working-memory slot,
		// a `context` contribution. The closing directive must still be the
		// LAST thing the model reads, or a step-context message after it
		// reframes what should be a final instruction.
		const contributions = new PromptContributionRegistry()
		contributions.register({ id: 'obs', placement: 'context', render: () => 'OBSERVATION' })
		const { provider } = await run(
			[
				mode === 'warning'
					? { ...toolTurn, usage: { promptTokens: 475, completionTokens: 475, totalTokens: 950 } }
					: { text: '', usage },
				{ text: 'A partial observation is available; the task is unresolved.', usage },
			],
			{ tokenBudget: 1_000 },
			{ workingMemoryProvider: () => 'HOST LEDGER', promptContributions: contributions },
		)
		const messages = provider.requests[1]?.messages ?? []
		const last = messages[messages.length - 1]
		if (last?.role !== 'user') throw new Error('the closing request does not end on a user turn')
		expect(last.source).toEqual({ type: 'runtime-context', kind: 'limit-finalization' })
		const text = messages.map((m) => (typeof m.content === 'string' ? m.content : ''))
		const ledgerAt = text.findIndex((t) => t.includes('HOST LEDGER'))
		expect(ledgerAt).toBeGreaterThanOrEqual(0)
		expect(ledgerAt).toBeLessThan(messages.length - 1)
		if (mode === 'warning') {
			const observationAt = text.findIndex((t) => t.includes('OBSERVATION'))
			expect(observationAt).toBeGreaterThanOrEqual(0)
			expect(observationAt).toBeLessThan(messages.length - 1)
		}
	},
)

describe('a hard stop starts no closing model request', () => {
	it('makes zero requests when the host cancels an unlimited run before admission', async () => {
		const controller = new AbortController()
		controller.abort()
		const { result, provider } = await run(
			[{ text: 'should not run' }],
			{ maxIterations: 0 },
			{ signal: controller.signal },
		)
		expect(provider.requests).toHaveLength(0)
		expect(result.stopReason).toBe('cancelled')
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
		expect(result.stopReason).toBe('token_budget')
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

describe('a forced prose summary preserves the reason it bypassed review', () => {
	const approaching = { promptTokens: 475, completionTokens: 475, totalTokens: 950 }
	const summary: MockTurn = {
		text: 'Unverified closing summary.',
		usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
	}

	it.each([
		{ reason: 'token_budget', limits: { tokenBudget: 1_000 } },
		{ reason: 'cost_limit', limits: { costLimitUsd: 0.001 } },
		{ reason: 'timeout', limits: { timeoutMs: 10_000 } },
	] as const)('reports %s on the run and terminal event', async ({ reason, limits }) => {
		let now = Date.now()
		vi.spyOn(Date, 'now').mockImplementation(() => now)
		const review = vi.fn(() => ({ accept: true as const }))
		const { result, provider, events } = await run(
			[{ ...toolTurn, usage: approaching }, summary],
			limits,
			{
				reviewAnswer: review,
				onStepFinish: (step) => {
					if (reason === 'timeout' && step.stepNumber === 1) now += 9_500
				},
			},
		)
		expect(provider.requests).toHaveLength(2)
		expect(provider.requests[1]?.toolChoice).toBe('none')
		expect(review).not.toHaveBeenCalled()
		expect(result.result).toBe(summary.text)
		expect(result.stopReason).toBe(reason)
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'run_completed', stopReason: reason }),
		)
	})

	it('cannot turn a rejected candidate into an accepted run by reaching the warning threshold', async () => {
		const review = vi.fn(() => ({ accept: false as const, feedback: 'Missing original evidence.' }))
		const { result, provider } = await run(
			[{ text: 'Unsupported claim.', usage: approaching }, summary],
			{ tokenBudget: 1_000 },
			{ reviewAnswer: review },
		)
		expect(provider.requests).toHaveLength(2)
		expect(review).toHaveBeenCalledTimes(1)
		expect(result.result).toBe(summary.text)
		expect(result.stopReason).toBe('token_budget')
	})

	it('keeps cancellation ahead of the closing limit reason', async () => {
		const controller = new AbortController()
		const { result, provider } = await run(
			[{ ...toolTurn, usage: approaching }, summary],
			{ tokenBudget: 1_000 },
			{
				signal: controller.signal,
				onStepFinish: (step) => {
					if (step.stepNumber === 2) controller.abort()
				},
			},
		)
		expect(provider.requests).toHaveLength(2)
		expect(result.stopReason).toBe('cancelled')
	})

	it('still settles reviewed native output on the separate validated path', async () => {
		const review = vi.fn(() => ({ accept: true as const }))
		const { result } = await run(
			[
				{ ...toolTurn, usage: approaching },
				{ ...summary, text: '{"score":2}' },
			],
			{ tokenBudget: 1_000 },
			{ structuredOutput: { mode: 'native', schema: z.object({ score: z.number() }), review } },
		)
		expect(review).toHaveBeenCalledTimes(1)
		expect(result.structuredOutput).toEqual({ score: 2 })
		expect(result.stopReason).toBe('end_turn')
	})
})
