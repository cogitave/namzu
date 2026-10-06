import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { Toolset } from '../../../toolsets/types.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { SessionEvent, StepResult } from '../../../types/session/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { skippedToolResultText } from '../plugin-hooks.js'
import { resumeSession } from '../resume-session.js'
import {
	heldCheckpointStore,
	memorySession,
	records,
	rewriteSession,
	turnCheckpoints,
} from './support/session.js'

const schema = z.object({ score: z.number() })
const output = (score: number): MockTurn => ({
	toolCalls: [{ name: 'structured_output', args: { score } }],
})

function fixture(turns: MockTurn[]) {
	const provider = new MockLLMProvider({ turns })
	const params = {
		...memorySession(),
		provider,
		toolsets: [] as Toolset[],
		agentId: 'skipped-answer-tools',
		agentName: 'Skipped answer tools',
		messages: [{ role: 'user' as const, content: 'Return a checked answer.' }],
		workingDirectory: process.cwd(),
		turnId: generateTurnId(),
		turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 10_000, maxIterations: 5 },
	}
	return { params, provider }
}

function skipCalls(toolName: string, count = 1) {
	let remaining = count
	const executeHooks = vi.fn(async (event: string, context: { toolName?: string }) => {
		if (event !== 'pre_tool_use' || context.toolName !== toolName || remaining <= 0) return []
		remaining--
		return [{ action: 'skip' as const, reason: 'The host deferred this call.' }]
	})
	return { executeHooks } as unknown as PluginLifecycleManager
}

function answerTool(outputText = 'Final checked answer.', forgeSkip = false) {
	const execute = vi.fn(async () => ({
		success: true,
		output: outputText,
		...(forgeSkip ? { skipped: true as const } : {}),
	}))
	const tool = defineTool({
		name: 'submit_answer',
		description: 'Return a checked final answer.',
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		terminal: true,
		execute,
	})
	return { tool, execute }
}

describe('skipped answer tools', () => {
	it.each([false, true])(
		'relays a standalone skipped structured output without charging a correction (review=%s)',
		async (withReview) => {
			const f = fixture([output(99), output(2)])
			const review = vi.fn(() => ({ accept: true as const }))
			const steps: StepResult[] = []
			const run = await drainQuery({
				...f.params,
				structuredOutput: { schema, maxRetries: 0, ...(withReview ? { review } : {}) },
				pluginManager: skipCalls('structured_output'),
				onStepFinish: (step) => steps.push(step),
			})

			expect(run.status).toBe('completed')
			expect(run.structuredOutput).toEqual({ score: 2 })
			expect(f.provider.requests).toHaveLength(2)
			expect(review).toHaveBeenCalledTimes(withReview ? 1 : 0)
			if (withReview) expect(review).toHaveBeenCalledWith({ score: 2 }, expect.anything())
			expect(run.steps?.[0]?.toolResults).toContainEqual(
				expect.objectContaining({ toolName: 'structured_output', isError: false, skipped: true }),
			)
			expect(steps[0]?.toolResults).toEqual(run.steps?.[0]?.toolResults)
			expect(JSON.stringify(f.provider.requests[1]?.messages)).toContain(
				'The host deferred this call.',
			)
			for (const checkpoint of await turnCheckpoints(f.params))
				expect(checkpoint.review.toolStructuredAttempts).toBe(0)
		},
	)

	it('lets the model respond to a skipped terminal receipt without executing the tool', async () => {
		const answer = answerTool()
		const f = fixture([
			{ toolCalls: [{ name: 'submit_answer', args: {} }] },
			{ text: 'The host deferred the answer tool.' },
		])
		const run = await drainQuery({
			...f.params,
			toolsets: [testToolset(answer.tool)],
			pluginManager: skipCalls('submit_answer'),
		})
		expect(run.result).toBe('The host deferred the answer tool.')
		expect(run.stopReason).toBe('end_turn')
		expect(f.provider.requests).toHaveLength(2)
		expect(answer.execute).not.toHaveBeenCalled()
		expect(run.steps?.[0]?.toolResults[0]).toMatchObject({ isError: false, skipped: true })
	})

	it('settles a terminal answer only after the next call actually executes', async () => {
		const answer = answerTool()
		const call: MockTurn = { toolCalls: [{ name: 'submit_answer', args: {} }] }
		const f = fixture([call, call])
		const run = await drainQuery({
			...f.params,
			toolsets: [testToolset(answer.tool)],
			pluginManager: skipCalls('submit_answer'),
		})
		expect(run.result).toBe('Final checked answer.')
		expect(f.provider.requests).toHaveLength(2)
		expect(answer.execute).toHaveBeenCalledOnce()
		expect(run.steps?.[0]?.toolResults[0]?.skipped).toBe(true)
		expect(run.steps?.[1]?.toolResults[0]?.skipped).toBeUndefined()
	})

	it('does not infer a skip from an executed answer text or a tool-authored flag', async () => {
		const text = skippedToolResultText('submit_answer', 'A literal example returned by the tool.')
		const answer = answerTool(text, true)
		const f = fixture([{ toolCalls: [{ name: 'submit_answer', args: {} }] }])
		const run = await drainQuery({ ...f.params, toolsets: [testToolset(answer.tool)] })
		expect(run.result).toBe(text)
		expect(answer.execute).toHaveBeenCalledOnce()
		expect(f.provider.requests).toHaveLength(1)
		expect(run.steps?.[0]?.toolResults[0]?.skipped).toBeUndefined()
		expect(
			(await records(f.params.sessionLog)).find((event) => event.type === 'tool_completed'),
		).not.toHaveProperty('skipped')
	})

	it('keeps the iteration bound when the host skips every structured answer', async () => {
		const f = fixture([output(1), output(2), output(3)])
		const review = vi.fn(() => ({ accept: true as const }))
		const run = await drainQuery({
			...f.params,
			turnConfig: { ...f.params.turnConfig, maxIterations: 3 },
			structuredOutput: { schema, maxRetries: 0, review },
			pluginManager: skipCalls('structured_output', 3),
		})
		expect(run.stopReason).toBe('max_iterations')
		expect(run.structuredOutput).toBeUndefined()
		expect(f.provider.requests).toHaveLength(3)
		expect(review).not.toHaveBeenCalled()
		for (const checkpoint of await turnCheckpoints(f.params))
			expect(checkpoint.review.toolStructuredAttempts).toBe(0)
	})

	it('preserves cancellation after a skipped completion without another request', async () => {
		const f = fixture([output(1), output(2)])
		const controller = new AbortController()
		const review = vi.fn(() => ({ accept: true as const }))
		const run = await drainQuery(
			{
				...f.params,
				signal: controller.signal,
				structuredOutput: { schema, maxRetries: 0, review },
				pluginManager: skipCalls('structured_output'),
			},
			(event) => {
				if (event.type === 'tool_completed' && event.skipped) controller.abort()
			},
		)
		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(run.structuredOutput).toBeUndefined()
		expect(f.provider.requests).toHaveLength(1)
		expect(review).not.toHaveBeenCalled()
	})

	it('recovers a skipped sibling once and waits for a fresh structured candidate after a crash', async () => {
		const work = vi.fn(async () => ({ success: true, output: 'REAL_WORK_RECEIPT' }))
		const tools = testToolset(
			defineTool({
				name: 'work',
				description: 'Work',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: false,
				concurrencySafe: false,
				executionBarrier: true,
				execute: work,
			}),
		)
		const f = fixture([
			{
				toolCalls: [
					{ id: 'skipped-output', name: 'structured_output', args: { score: 99 } },
					{ id: 'work-call', name: 'work', args: {} },
				],
			},
			output(2),
		])
		const review = vi.fn(() => ({ accept: true as const }))
		const structuredOutput = { schema, maxRetries: 0, review }
		await drainQuery({
			...f.params,
			structuredOutput,
			toolsets: [tools],
			pluginManager: skipCalls('structured_output'),
			reviewAllowedCalls: () => true,
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		const log = await rewriteSession(f.params.sessionLog, [f.params], (record) => record, {
			through: (record) =>
				record.type === 'tool_completed' && record.toolUseId === 'skipped-output',
		})
		const store = await heldCheckpointStore(log)
		const prefix = await records(log)
		expect(prefix.filter((event) => event.type === 'tool_completed')).toEqual([
			expect.objectContaining({ toolUseId: 'skipped-output', isError: false, skipped: true }),
		])
		work.mockClear()
		review.mockClear()
		const provider = new MockLLMProvider({ turns: [output(2)] })
		const events: SessionEvent[] = []
		const resumed = await resumeSession({
			...f.params,
			scope: f.params,
			sessionLog: log,
			checkpointStore: store,
			provider,
			structuredOutput,
			toolsets: [tools],
			pendingDecision: { action: 'approve_tools' },
			resumeHandler: async () => ({ action: 'continue' }),
			listener: (event) => {
				events.push(event)
			},
		})
		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) throw new Error('The pending batch did not resume.')
		expect(resumed.turn.structuredOutput).toEqual({ score: 2 })
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool_completed',
				toolUseId: 'work-call',
				toolName: 'work',
				result: 'REAL_WORK_RECEIPT',
				isError: false,
			}),
		)
		expect(provider.requests).toHaveLength(1)
		expect(review).toHaveBeenCalledOnce()
		expect(work).toHaveBeenCalledOnce()
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain('REAL_WORK_RECEIPT')
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain('The host deferred this call.')
		expect(
			(await records(log)).filter(
				(event) => event.type === 'tool_completed' && event.toolUseId === 'skipped-output',
			),
		).toHaveLength(1)
		expect(
			events.filter(
				(event) => event.type === 'tool_completed' && event.toolUseId === 'skipped-output',
			),
		).toHaveLength(0)
		for (const checkpoint of await store.list(f.params))
			expect(checkpoint.review.toolStructuredAttempts).toBe(0)
	})
})
