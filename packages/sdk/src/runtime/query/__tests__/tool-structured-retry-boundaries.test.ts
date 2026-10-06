import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { probe } from '../../../probe/registry.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { Toolset } from '../../../toolsets/types.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../types/hitl/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { memorySession, terminalRecords, turnCheckpoints } from './support/session.js'

const scoreSchema = z.object({ score: z.number() })

function output(score: number): MockTurn {
	return { toolCalls: [{ name: 'structured_output', args: { score } }] }
}

function fixture(turns: MockTurn[], schema: z.ZodType = scoreSchema) {
	const provider = new MockLLMProvider({ turns })
	const params = {
		...memorySession(),
		provider,
		toolsets: [] as Toolset[],
		agentId: 'structured-retry-boundaries',
		agentName: 'Structured retry boundaries',
		messages: [{ role: 'user' as const, content: 'Do the work, then return a structured score.' }],
		workingDirectory: process.cwd(),
		turnId: generateTurnId(),
		turnConfig: {
			model: 'mock',
			tokenBudget: 100_000,
			timeoutMs: 10_000,
			maxIterations: 5,
		},
		structuredOutput: { schema, maxRetries: 0 },
	}
	return { params, provider }
}

function workTool(failed = false) {
	const execute = vi.fn(async () =>
		failed
			? { success: false, output: '', error: 'The work tool could not finish.' }
			: { success: true, output: 'Work finished.' },
	)
	const tool = defineTool({
		name: 'work',
		description: 'A separate work tool used before the structured result.',
		inputSchema: z.object({ value: z.string() }),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute,
	})
	return { tool, execute }
}

function preHookOnce(result: PluginHookResult) {
	let handled = false
	const hook = vi.fn(async (event: string, context: { toolName?: string }) => {
		if (event !== 'pre_tool_use' || context.toolName !== 'structured_output' || handled) return []
		handled = true
		return [result]
	})
	return { pluginManager: { executeHooks: hook } as unknown as PluginLifecycleManager, hook }
}

async function expectNoSchemaCorrections(params: ReturnType<typeof fixture>['params']) {
	const checkpoints = await turnCheckpoints(params)
	for (const checkpoint of checkpoints) expect(checkpoint.review.toolStructuredAttempts).toBe(0)
}

describe('tool structured schema retry boundaries', () => {
	it.each(['schema failure', 'execution failure'] as const)(
		'does not spend the output schema budget on a work tool %s',
		async (failure) => {
			const work = workTool(failure === 'execution failure')
			const f = fixture([
				{
					toolCalls: [
						{ name: 'work', args: { value: failure === 'schema failure' ? 42 : 'ready' } },
					],
				},
				output(2),
			])
			const run = await drainQuery({ ...f.params, toolsets: [testToolset(work.tool)] })

			expect(run.status).toBe('completed')
			expect(run.structuredOutput).toEqual({ score: 2 })
			expect(f.provider.requests).toHaveLength(2)
			expect(work.execute).toHaveBeenCalledTimes(failure === 'schema failure' ? 0 : 1)
			expect(run.steps?.[0]?.toolResults).toContainEqual(
				expect.objectContaining({ toolName: 'work', isError: true }),
			)
			await expectNoSchemaCorrections(f.params)
		},
	)

	it('relays a valid output paired with work without spending a schema correction', async () => {
		const work = workTool()
		const f = fixture([
			{
				toolCalls: [
					{ name: 'structured_output', args: { score: 99 } },
					{ name: 'work', args: { value: 'ready' } },
				],
			},
			output(2),
		])
		const review = vi.fn(() => ({ accept: true as const }))
		const run = await drainQuery({
			...f.params,
			toolsets: [testToolset(work.tool)],
			structuredOutput: { ...f.params.structuredOutput, review },
		})

		expect(run.status).toBe('completed')
		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(f.provider.requests).toHaveLength(2)
		expect(work.execute).toHaveBeenCalledOnce()
		expect(review).toHaveBeenCalledExactlyOnceWith({ score: 2 }, expect.anything())
		await expectNoSchemaCorrections(f.params)
	})

	it('uses a successful local argument repair without another model correction', async () => {
		const f = fixture([{ toolCalls: [{ name: 'structured_output', args: { score: 'wrong' } }] }])
		const repair = vi.fn(() => ({ arguments: '{"score":2}' }))
		const run = await drainQuery({ ...f.params, repairToolCall: repair })

		expect(run.status).toBe('completed')
		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(f.provider.requests).toHaveLength(1)
		expect(repair).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				tool: expect.objectContaining({ name: 'structured_output' }),
				reason: 'schema_validation',
			}),
		)
		await expectNoSchemaCorrections(f.params)
	})

	it('keeps semantic host review corrections separate from a zero schema allowance', async () => {
		const f = fixture([output(99), output(2)])
		const review = vi.fn((value: unknown) =>
			scoreSchema.parse(value).score < 10
				? { accept: true as const }
				: { accept: false as const, feedback: 'The score must be below ten.' },
		)
		const run = await drainQuery({
			...f.params,
			structuredOutput: { ...f.params.structuredOutput, review, maxReviews: 1 },
		})

		expect(run.status).toBe('completed')
		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(f.provider.requests).toHaveLength(2)
		expect(review).toHaveBeenCalledTimes(2)
		expect(run.messages).toContainEqual(
			expect.objectContaining({
				content: 'The score must be below ten.',
				source: { type: 'runtime-context', kind: 'answer-review' },
			}),
		)
		const checkpoints = await turnCheckpoints(f.params)
		expect(checkpoints).toContainEqual(
			expect.objectContaining({
				review: expect.objectContaining({ structuredAttempts: 1, toolStructuredAttempts: 0 }),
			}),
		)
		await expectNoSchemaCorrections(f.params)
	})

	it('does not charge a gate refusal of schema-valid output to the model', async () => {
		const f = fixture([output(99), output(2)])
		const decide = vi.fn(({ toolInput }: { toolInput: unknown }) =>
			scoreSchema.parse(toolInput).score === 99 ? ('deny' as const) : ('allow' as const),
		)
		const authorizationGate: AuthorizationGateConfig = {
			enabled: true,
			rules: [{ type: 'predicate', description: 'Score 99 is refused by the host.', decide }],
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
		}
		const run = await drainQuery({ ...f.params, authorizationGate })

		expect(run.status).toBe('completed')
		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(f.provider.requests).toHaveLength(2)
		expect(run.steps?.[0]?.toolResults).toContainEqual(
			expect.objectContaining({
				isError: true,
				output: expect.stringMatching(/authorization gate/i),
			}),
		)
		expect(decide).toHaveBeenCalled()
		await expectNoSchemaCorrections(f.params)
	})

	it('does not charge a probe veto of schema-valid output to the model', async () => {
		const f = fixture([output(99), output(2)])
		const veto = vi.fn((event: { input: unknown }) =>
			scoreSchema.parse(event.input).score === 99
				? { action: 'deny' as const, reason: 'Score 99 is refused by the probe.' }
				: ('allow' as const),
		)
		const unsubscribe = probe.veto('tool_executing', veto, {
			where: (event) => event.sessionId === f.params.sessionId,
		})
		try {
			const run = await drainQuery(f.params)

			expect(run.status).toBe('completed')
			expect(run.structuredOutput).toEqual({ score: 2 })
			expect(f.provider.requests).toHaveLength(2)
			expect(veto).toHaveBeenCalledTimes(2)
			expect(run.steps?.[0]?.toolResults).toContainEqual(
				expect.objectContaining({ isError: true, output: expect.stringContaining('probe') }),
			)
			await expectNoSchemaCorrections(f.params)
		} finally {
			unsubscribe()
		}
	})

	it('does not charge a pre-tool hook error to the schema allowance', async () => {
		const f = fixture([output(99), output(2)])
		const hook = preHookOnce({ action: 'error', message: 'The host deferred this result.' })
		const run = await drainQuery({ ...f.params, pluginManager: hook.pluginManager })

		expect(run.status).toBe('completed')
		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(f.provider.requests).toHaveLength(2)
		expect(run.steps?.[0]?.toolResults).toContainEqual(
			expect.objectContaining({ isError: true, output: 'Error: The host deferred this result.' }),
		)
		await expectNoSchemaCorrections(f.params)
	})

	it('does not charge a skipped output paired with work to the schema allowance', async () => {
		const work = workTool()
		const f = fixture([
			{
				toolCalls: [
					{ name: 'structured_output', args: { score: 99 } },
					{ name: 'work', args: { value: 'ready' } },
				],
			},
			output(2),
		])
		const hook = preHookOnce({ action: 'skip', reason: 'Wait for the work result.' })
		const run = await drainQuery({
			...f.params,
			toolsets: [testToolset(work.tool)],
			pluginManager: hook.pluginManager,
		})

		expect(run.status).toBe('completed')
		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(f.provider.requests).toHaveLength(2)
		expect(work.execute).toHaveBeenCalledOnce()
		expect(run.steps?.[0]?.toolResults).toContainEqual(
			expect.objectContaining({
				toolName: 'structured_output',
				isError: false,
				output: expect.stringContaining('skipped'),
			}),
		)
		await expectNoSchemaCorrections(f.params)
	})

	it('does not charge invalid input introduced by a pre-tool hook to the model', async () => {
		const f = fixture([output(99), output(2)])
		const hook = preHookOnce({ action: 'modify', input: { score: 'host modification' } })
		const run = await drainQuery({ ...f.params, pluginManager: hook.pluginManager })

		expect(run.status).toBe('completed')
		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(f.provider.requests).toHaveLength(2)
		expect(run.steps?.[0]?.toolResults).toContainEqual(
			expect.objectContaining({ toolName: 'structured_output', isError: true }),
		)
		await expectNoSchemaCorrections(f.params)
	})

	it('does not charge invalid input introduced by human review to the model', async () => {
		const f = fixture([output(99), output(2)])
		let reviewedBatches = 0
		const review = vi.fn(async (request: HITLDecisionRequest): Promise<HITLResumeDecision> => {
			if (request.type !== 'tool_review') return { action: 'continue' }
			return ++reviewedBatches === 1
				? {
						action: 'modify_tools' as const,
						modifications: [
							{
								toolCallId: request.toolCalls[0]?.id ?? '',
								action: 'modify' as const,
								modifiedInput: { score: 'human modification' },
							},
						],
					}
				: { action: 'approve_tools' as const }
		})
		const run = await drainQuery({
			...f.params,
			reviewAllowedCalls: () => true,
			resumeHandler: review,
		})

		expect(run.status).toBe('completed')
		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(f.provider.requests).toHaveLength(2)
		expect(reviewedBatches).toBe(2)
		expect(review.mock.calls.filter(([request]) => request.type === 'tool_review')).toEqual([
			[
				expect.objectContaining({
					toolCalls: [expect.objectContaining({ input: { score: 99 } })],
				}),
			],
			[
				expect.objectContaining({
					toolCalls: [expect.objectContaining({ input: { score: 2 } })],
				}),
			],
		])
		expect(run.steps?.[0]?.toolResults).toContainEqual(
			expect.objectContaining({ toolName: 'structured_output', isError: true }),
		)
		await expectNoSchemaCorrections(f.params)
	})

	it('preserves cancellation when the first invalid output exhausts a zero allowance', async () => {
		const controller = new AbortController()
		const f = fixture([
			{ toolCalls: [{ name: 'structured_output', args: { score: 'wrong' } }] },
			output(2),
		])
		const run = await drainQuery({ ...f.params, signal: controller.signal }, (event) => {
			if (event.type === 'iteration_completed' && event.iteration === 1) controller.abort()
		})

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(run.structuredOutput).toBeUndefined()
		expect(f.provider.requests).toHaveLength(1)
		expect(await turnCheckpoints(f.params)).toContainEqual(
			expect.objectContaining({ review: expect.objectContaining({ toolStructuredAttempts: 1 }) }),
		)
		expect(await terminalRecords(f.params.sessionLog)).toContainEqual(
			expect.objectContaining({ settlement: expect.objectContaining({ status: 'cancelled' }) }),
		)
	})

	it('does not reapply a schema transform when checking the retry boundary or publishing', async () => {
		const transform = vi.fn(({ score }: { score: number }) => ({ score: score + 1 }))
		const f = fixture([output(2)], scoreSchema.transform(transform))
		const review = vi.fn(() => ({ accept: true as const }))
		const run = await drainQuery({
			...f.params,
			structuredOutput: { ...f.params.structuredOutput, review },
		})

		expect(run.status).toBe('completed')
		expect(run.structuredOutput).toEqual({ score: 3 })
		expect(f.provider.requests).toHaveLength(1)
		expect(transform).toHaveBeenCalledOnce()
		expect(review).toHaveBeenCalledExactlyOnceWith({ score: 3 }, expect.anything())
		await expectNoSchemaCorrections(f.params)
	})
})
