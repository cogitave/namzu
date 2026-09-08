import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { MockTurn } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery, query } from '../index.js'
import { SteeringBinding } from '../steering.js'

const schema = z.object({ score: z.number() })
function fixture(turns: MockTurn[]) {
	const provider = new MockLLMProvider({
		turns,
		capabilities: {
			supportsTools: true,
			supportsStreaming: true,
			supportsFunctionCalling: true,
			supportsNativeStructuredOutput: true,
		},
	})
	const params = {
		provider,
		tools: new ToolRegistry(),
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user' as const, content: 'Return a score' }],
		workingDirectory: process.cwd(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		runId: generateRunId(),
		runConfig: { model: 'mock', tokenBudget: 100_000, maxIterations: 10, timeoutMs: 10_000 },
		checkpointStore: new InMemoryCheckpointStore(),
		structuredOutput: { mode: 'native' as const, schema, maxRetries: 2 },
	}
	return { params, provider }
}

describe('native structured output through the real query loop', () => {
	it('forwards schema, validates text and settles without a synthetic tool or extra inference', async () => {
		const { params, provider } = fixture([{ text: '{"score":2}' }])
		const run = await drainQuery({ ...params, maxToolCalls: 0 })
		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(run.stopReason).toBe('end_turn')
		expect(provider.requests).toHaveLength(1)
		expect(provider.requests[0]?.responseFormat).toMatchObject({
			type: 'json_schema',
			json_schema: {
				name: 'structured_output',
				strict: true,
				schema: { type: 'object', properties: { score: { type: 'number' } } },
			},
		})
		expect(params.tools.has('structured_output')).toBe(false)
	})
	it.each(['not JSON', '{"score":"bad"}', '{"score":'])(
		'corrects invalid output %s with bounded feedback',
		async (text) => {
			const { params, provider } = fixture([{ text }, { text: '{"score":3}' }])
			const run = await drainQuery(params)
			expect(run.structuredOutput).toEqual({ score: 3 })
			expect(provider.requests).toHaveLength(2)
			expect(run.messages).toContainEqual(
				expect.objectContaining({ source: { type: 'runtime-context', kind: 'structured-output' } }),
			)
		},
	)
	it('persists validation exhaustion independently of compacted history', async () => {
		const { params, provider } = fixture([{ text: 'invalid' }])
		params.structuredOutput.maxRetries = 0
		expect((await drainQuery(params)).stopReason).toBe('structured_output_failed')
		const cp = (await params.checkpointStore.listCheckpoints(params)).find(
			(item) => item.nativeStructuredAttempts === 1,
		)
		expect(cp).toBeDefined()
		if (!cp) throw new Error('Missing correction checkpoint')
		await params.checkpointStore.writeCheckpoint(params, {
			...cp,
			messages: [{ role: 'user', content: 'Compacted' }],
		})
		provider.reset()
		const run = await drainQuery({
			...params,
			tools: new ToolRegistry(),
			resumeFromCheckpoint: cp.id,
		})
		expect(run.stopReason).toBe('structured_output_failed')
		expect(run.structuredOutput).toBeUndefined()
		expect(provider.requests).toHaveLength(0)
	})
	it('shares host review feedback and rejects a semantically wrong candidate', async () => {
		const { params, provider } = fixture([{ text: '{"score":99}' }, { text: '{"score":2}' }])
		const review = vi.fn((value: unknown) =>
			schema.parse(value).score < 10
				? { accept: true as const }
				: { accept: false as const, feedback: 'Score must be below ten' },
		)
		const run = await drainQuery({
			...params,
			structuredOutput: { ...params.structuredOutput, review },
		})
		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(review).toHaveBeenCalledTimes(2)
		expect(provider.requests).toHaveLength(2)
	})
	it('fails closed on a throwing host reviewer', async () => {
		const { params } = fixture([{ text: '{"score":2}' }])
		const run = await drainQuery({
			...params,
			structuredOutput: {
				...params.structuredOutput,
				review: () => {
					throw new Error('Verifier offline')
				},
			},
		})
		expect(run.status).toBe('failed')
		expect(run.structuredOutput).toBeUndefined()
	})
	it('executes interleaved tools and only settles the subsequent tool-free answer', async () => {
		const { params, provider } = fixture([
			{
				text: '{"score":99}',
				toolCalls: [
					{
						name: 'observe',
						args: {},
					},
				],
			},
			{ text: '{"score":2}' },
		])
		const execute = vi.fn(async () => ({ success: true, output: 'Observed 2' }))
		params.tools.register(
			defineTool({
				name: 'observe',
				terminal: true,
				category: 'analysis',
				permissions: [],
				destructive: false,
				concurrencySafe: true,
				description: 'Observe',
				inputSchema: z.object({}),
				execute,
				readOnly: true,
			}),
		)
		const run = await drainQuery(params)
		expect(execute).toHaveBeenCalledTimes(1)
		expect(provider.requests).toHaveLength(2)
		expect(run.structuredOutput).toEqual({ score: 2 })
	})
	it.each(['length', 'content_filter'] as const)(
		'does not accept JSON with finish reason %s',
		async (finishReason) => {
			const { params, provider } = fixture([
				{ text: '{"score":99}', finishReason },
				{ text: '{"score":2}' },
			])
			expect((await drainQuery(params)).structuredOutput).toEqual({ score: 2 })
			expect(provider.requests).toHaveLength(2)
		},
	)
	it('does not bypass validation during forced finalization', async () => {
		const { params } = fixture([{ text: 'invalid' }])
		const run = await drainQuery({
			...params,
			runConfig: { ...params.runConfig, maxIterations: 1 },
			structuredOutput: { ...params.structuredOutput, maxRetries: 0 },
		})
		expect(run.stopReason).toBe('structured_output_failed')
		expect(run.structuredOutput).toBeUndefined()
	})
	it('cancels a validation promise that never settles', async () => {
		const controller = new AbortController()
		const { params } = fixture([{ text: '{"score":2}' }])
		const never = schema.superRefine(async () => {
			controller.abort()
			await new Promise(() => {})
		})
		const run = await drainQuery({
			...params,
			signal: controller.signal,
			structuredOutput: { ...params.structuredOutput, schema: never },
		})
		expect(run.status).toBe('cancelled')
		expect(run.structuredOutput).toBeUndefined()
	})
	it.each([() => Number.POSITIVE_INFINITY, () => new Date(), () => ({ missing: undefined })])(
		'refuses schema transforms that would be changed by JSON serialization',
		async (transform) => {
			const { params } = fixture([{ text: '{"score":2}' }])
			const review = vi.fn(() => ({ accept: true as const }))
			const run = await drainQuery({
				...params,
				structuredOutput: {
					...params.structuredOutput,
					schema: schema.transform((): unknown => transform()),
					review,
				},
			})
			expect(run.status).toBe('failed')
			expect(run.structuredOutput).toBeUndefined()
			expect(review).not.toHaveBeenCalled()
		},
	)
	it('applies an asynchronous JSON transform exactly once before host review', async () => {
		const { params } = fixture([{ text: '{"score":2}' }])
		const transform = vi.fn(async (value: { score: number }) => ({ score: value.score + 1 }))
		const review = vi.fn(() => ({ accept: true as const }))
		const run = await drainQuery({
			...params,
			structuredOutput: { ...params.structuredOutput, schema: schema.transform(transform), review },
		})
		expect(run.structuredOutput).toEqual({ score: 3 })
		expect(transform).toHaveBeenCalledTimes(1)
		expect(review).toHaveBeenCalledWith({ score: 3 }, expect.anything())
	})
	it.each(['native', 'tool'] as const)(
		'does not publish an accepted %s candidate after cancellation at the settlement event',
		async (mode) => {
			const { params } = fixture(
				mode === 'native'
					? [{ text: '{"score":2}' }]
					: [{ toolCalls: [{ name: 'structured_output', args: { score: 2 } }] }],
			)
			const controller = new AbortController()
			const iterator = query({
				...params,
				structuredOutput: { ...params.structuredOutput, mode },
				signal: controller.signal,
				resumeHandler: async () => ({ action: 'continue' }),
			})
			let result = await iterator.next()
			while (!result.done) {
				if (result.value.type === 'iteration_completed') controller.abort()
				result = await iterator.next()
			}
			expect(result.value.status).toBe('cancelled')
			expect(result.value.structuredOutput).toBeUndefined()
		},
	)
	it('consumes an operator correction before settling a native candidate', async () => {
		const { params, provider } = fixture([{ text: '{"score":2}' }, { text: '{"score":3}' }])
		const steering = new SteeringBinding()
		const iterator = query({
			...params,
			steering,
			resumeHandler: async () => ({ action: 'continue' }),
		})
		let steered = false
		let result = await iterator.next()
		while (!result.done) {
			if (!steered && result.value.type === 'message_started') {
				steered = true
				steering.steer('Correction: return score 3')
			}
			result = await iterator.next()
		}
		expect(result.value.structuredOutput).toEqual({ score: 3 })
		expect(provider.requests).toHaveLength(2)
		expect(provider.requests[1]?.messages).toContainEqual(
			expect.objectContaining({ content: expect.stringContaining('Correction: return score 3') }),
		)
		expect(steering.pending).toBe(false)
	})
	it.each(['native', 'tool'] as const)(
		'invalidates blocked or rewritten %s structured output',
		async (mode) => {
			for (const action of ['block', 'rewrite'] as const) {
				const { params } = fixture(
					mode === 'native'
						? [{ text: '{"score":99}' }]
						: [{ toolCalls: [{ name: 'structured_output', args: { score: 99 } }] }],
				)
				const run = await drainQuery({
					...params,
					structuredOutput: { ...params.structuredOutput, mode },
					outputGuardrails: [
						() =>
							action === 'block'
								? { action: 'block', reason: 'Blocked' }
								: { action: 'rewrite', output: 'Redacted' },
					],
				})
				expect(run.structuredOutput).toBeUndefined()
				expect(run.stopReason).toBe('output_guardrail')
				expect(run.result).toBe(action === 'block' ? '' : 'Redacted')
			}
		},
	)
	it('preserves large native results independently of the tool-output preview cap', async () => {
		const text = 'a'.repeat(50_000)
		const { params } = fixture([{ text: JSON.stringify({ text }) }])
		const run = await drainQuery({
			...params,
			maxToolOutputChars: 20,
			structuredOutput: { ...params.structuredOutput, schema: z.object({ text: z.string() }) },
		})
		expect(run.structuredOutput).toEqual({ text })
	})
	it.each(['block', 'rewrite'] as const)(
		'preserves cancellation through a final %s guardrail',
		async (action) => {
			const { params } = fixture([{ text: '{"score":2}' }])
			const controller = new AbortController()
			const iterator = query({
				...params,
				signal: controller.signal,
				resumeHandler: async () => ({ action: 'continue' }),
				outputGuardrails: [
					() =>
						action === 'block'
							? { action: 'block', reason: 'Blocked' }
							: { action: 'rewrite', output: 'Redacted' },
				],
			})
			let result = await iterator.next()
			while (!result.done) {
				if (result.value.type === 'iteration_completed') controller.abort()
				result = await iterator.next()
			}
			expect(result.value.status).toBe('cancelled')
			expect(result.value.stopReason).toBe('cancelled')
			expect(result.value.structuredOutput).toBeUndefined()
		},
	)
})
