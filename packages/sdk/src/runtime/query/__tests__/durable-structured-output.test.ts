import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import { memorySession, records, terminalRecords } from './support/session.js'

const scoreSchema = z.object({ score: z.number() })

function output(score: number, id = `output-${score}`): MockTurn {
	return { toolCalls: [{ id, name: 'structured_output', args: { score } }] }
}

function fixture(turns: MockTurn[], schema: z.ZodType = scoreSchema) {
	const provider = new MockLLMProvider({ turns })
	const params = {
		...memorySession(),
		provider,
		toolsets: [],
		agentId: 'durable-structured-output',
		agentName: 'Durable structured output',
		messages: [createUserMessage('Return a structured answer.')],
		workingDirectory: process.cwd(),
		turnId: generateTurnId(),
		turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 10_000, maxIterations: 4 },
		structuredOutput: { schema, toolResultRetention: 'durable', maxRetries: 0 },
		resumeHandler: async () => ({ action: 'continue' as const }),
	} satisfies QueryParams
	return { params, provider }
}

async function run(f: ReturnType<typeof fixture>, overrides: Partial<QueryParams> = {}) {
	const events: SessionEvent[] = []
	const result = await drainQuery(
		{
			...f.params,
			...overrides,
			structuredOutput: {
				...f.params.structuredOutput,
				...overrides.structuredOutput,
				schema: overrides.structuredOutput?.schema ?? f.params.structuredOutput.schema,
			},
		},
		(event) => {
			events.push(event)
		},
	)
	const completions = events.filter(
		(event): event is Extract<SessionEvent, { type: 'tool_completed' }> =>
			event.type === 'tool_completed',
	)
	return { result, events, completions }
}

function postHook(
	result: PluginHookResult,
	phase: 'pre_tool_use' | 'post_tool_use' = 'post_tool_use',
) {
	const executeHooks = vi.fn(async (event: string) => (event === phase ? [result] : []))
	return {
		pluginManager: { executeHooks } as unknown as PluginLifecycleManager,
		executeHooks,
	}
}

describe('opt-in durable structured tool result', () => {
	it('keeps the default and explicit receipt policy unchanged under the output cap', async () => {
		for (const retention of [undefined, 'receipt'] as const) {
			const text = 'x'.repeat(50_000)
			const f = fixture(
				[{ toolCalls: [{ id: 'candidate', name: 'structured_output', args: { text } }] }],
				z.object({ text: z.string() }),
			)
			const { result, completions } = await run(f, {
				maxToolOutputChars: 100,
				structuredOutput: {
					schema: z.object({ text: z.string() }),
					toolResultRetention: retention,
				},
			})
			expect(result.status).toBe('failed')
			expect(result.structuredOutput).toBeUndefined()
			expect(result.lastError).toContain('intact JSON tool result')
			expect(completions[0]?.structuredResultJson).toBeUndefined()
		}
	})

	it('retains bounded-preview JSON across the actual execution and review boundaries', async () => {
		const text = 'x'.repeat(50_000)
		const transform = vi.fn(async ({ text }: { text: string }) => ({ text: `${text}!` }))
		const schema = z.object({ text: z.string() }).transform(transform)
		const f = fixture(
			[{ toolCalls: [{ id: 'candidate', name: 'structured_output', args: { text } }] }],
			schema,
		)
		const review = vi.fn((value: unknown) => {
			const candidate = value as { text: string }
			expect(candidate.text).toBe(`${text}!`)
			candidate.text = 'reviewer mutation'
			return { accept: true as const }
		})
		const { result, completions } = await run(f, {
			maxToolOutputChars: 100,
			structuredOutput: { schema, toolResultRetention: 'durable', review },
		})
		const expected = { text: `${text}!` }
		expect(result.status).toBe('completed')
		expect(result.stopReason).toBe('end_turn')
		expect(result.structuredOutput).toEqual(expected)
		expect(result.result).toBe(JSON.stringify(expected))
		expect(review).toHaveBeenCalledOnce()
		expect(transform).toHaveBeenCalledOnce()
		expect(f.provider.requests).toHaveLength(1)
		expect(completions).toHaveLength(1)
		expect(completions[0]).toMatchObject({ outputTruncated: true })
		expect(completions[0]?.result.length).toBeLessThan(1_000)
		expect(completions[0]?.structuredResultJson).toBe(JSON.stringify(expected))
		const toolMessage = result.messages.find((message) => message.role === 'tool')
		expect(toolMessage?.content).not.toBe(JSON.stringify(expected))
		expect(typeof toolMessage?.content === 'string' && toolMessage.content.length).toBeLessThan(
			1_000,
		)
		expect(result.steps?.[0]?.toolResults?.[0]).not.toHaveProperty('structuredResultJson')
		const completed = (await terminalRecords(f.params.sessionLog))[0]
		expect(completed?.type).toBe('turn_completed')
		expect(completed?.settlement.structuredOutput).toEqual(expected)
		const logged = (await records(f.params.sessionLog)).find(
			(record) => record.type === 'tool_completed',
		)
		expect(logged).toMatchObject({ structuredResultJson: JSON.stringify(expected) })
	})

	it.each(['guardrail', 'post-hook'] as const)(
		'uses the final valid JSON from a %s rewrite instead of the original tool data',
		async (source) => {
			const f = fixture([output(2)])
			const rewritten = '{"score":7}'
			const hook = postHook({ action: 'replace', output: rewritten })
			const { result, completions } = await run(f, {
				...(source === 'guardrail'
					? { toolResultGuardrails: [() => ({ action: 'rewrite' as const, output: rewritten })] }
					: { pluginManager: hook.pluginManager }),
			})
			expect(result.structuredOutput).toEqual({ score: 7 })
			expect(completions[0]?.structuredResultJson).toBe(rewritten)
			expect(completions[0]?.result).toBe(rewritten)
		},
	)

	it.each(['guardrail', 'post-hook'] as const)(
		'keeps non-JSON %s rewriting as a result-integrity failure',
		async (source) => {
			const f = fixture([output(2)])
			const rewritten = '[redacted result]'
			const hook = postHook({ action: 'replace', output: rewritten })
			const { result, completions } = await run(f, {
				...(source === 'guardrail'
					? { toolResultGuardrails: [() => ({ action: 'rewrite' as const, output: rewritten })] }
					: { pluginManager: hook.pluginManager }),
			})
			expect(result.status).toBe('failed')
			expect(result.structuredOutput).toBeUndefined()
			expect(result.lastError).toContain('intact JSON tool result')
			expect(completions[0]?.structuredResultJson).toBeUndefined()
		},
	)

	it.each(['refuse', 'halt', 'hook-error', 'skip'] as const)(
		'does not mint a JSON candidate after %s',
		async (path) => {
			const f = fixture([output(2)])
			const hook = postHook(
				path === 'skip'
					? { action: 'skip', reason: 'Deferred by host' }
					: { action: 'error', message: 'Rejected by host' },
				path === 'skip' ? 'pre_tool_use' : 'post_tool_use',
			)
			const { result, completions } = await run(f, {
				turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 10_000, maxIterations: 1 },
				...(path === 'refuse' || path === 'halt'
					? {
							toolResultGuardrails: [
								() =>
									path === 'refuse'
										? { action: 'refuse' as const, reason: 'Unsafe result' }
										: { action: 'halt' as const, reason: 'Unsafe result' },
							],
						}
					: { pluginManager: hook.pluginManager }),
			})
			expect(result.structuredOutput).toBeUndefined()
			expect(completions.every((completion) => completion.structuredResultJson === undefined)).toBe(
				true,
			)
		},
	)

	it('does not mint a result from asynchronous validation cancelled before execution', async () => {
		let entered!: () => void
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve
		})
		let release!: () => void
		const releasePromise = new Promise<void>((resolve) => {
			release = resolve
		})
		const controller = new AbortController()
		const schema = scoreSchema.superRefine(async () => {
			entered()
			await releasePromise
		})
		const f = fixture([output(2)], schema)
		const events: SessionEvent[] = []
		const pending = drainQuery({ ...f.params, signal: controller.signal }, (event) => {
			events.push(event)
		})
		await enteredPromise
		controller.abort(new Error('Stop before validation settles'))
		release()
		const result = await pending
		expect(result.status).toBe('cancelled')
		expect(result.structuredOutput).toBeUndefined()
		expect(
			events
				.filter((event) => event.type === 'tool_completed')
				.every((event) => event.structuredResultJson === undefined),
		).toBe(true)
	})

	it('relays a candidate paired with another tool and settles only the later solitary answer', async () => {
		const work = defineTool({
			name: 'work',
			description: 'Another tool in the same batch',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'work done' }),
		})
		const f = fixture([
			{
				toolCalls: [
					{ id: 'first-output', name: 'structured_output', args: { score: 1 } },
					{ id: 'work', name: 'work', args: {} },
				],
			},
			output(2, 'second-output'),
		])
		const review = vi.fn(() => ({ accept: true as const }))
		const { result, completions } = await run(f, {
			toolsets: [testToolset(work)],
			structuredOutput: { schema: scoreSchema, toolResultRetention: 'durable', review },
		})
		expect(f.provider.requests).toHaveLength(2)
		expect(result.structuredOutput).toEqual({ score: 2 })
		expect(review).toHaveBeenCalledOnce()
		expect(
			completions.find((completion) => completion.toolUseId === 'first-output')
				?.structuredResultJson,
		).toBe('{"score":1}')
		expect(
			completions.find((completion) => completion.toolUseId === 'work')?.structuredResultJson,
		).toBeUndefined()
	})

	it('reconsiders a stale durable candidate after inbound input', async () => {
		const inbound: Message[] = []
		const provider = new MockLLMProvider({
			nextTurn: (_request, index) => {
				if (index === 0) inbound.push(createUserMessage('Use score 2 instead.'))
				return output(index === 0 ? 1 : 2, `candidate-${index}`)
			},
		})
		const f = fixture([])
		const { result } = await run(
			{ ...f, provider, params: { ...f.params, provider } },
			{ inboundMessages: () => inbound.splice(0) },
		)
		expect(provider.requests).toHaveLength(2)
		expect(result.structuredOutput).toEqual({ score: 2 })
	})

	it.each(['block', 'rewrite'] as const)(
		'lets the final output guardrail invalidate a durable %s result',
		async (action) => {
			const f = fixture([output(2)])
			const { result, completions } = await run(f, {
				outputGuardrails: [
					() =>
						action === 'block'
							? { action: 'block' as const, reason: 'No final answer' }
							: { action: 'rewrite' as const, output: 'Redacted' },
				],
			})
			expect(completions[0]?.structuredResultJson).toBe('{"score":2}')
			expect(result.structuredOutput).toBeUndefined()
			expect(result.stopReason).toBe('output_guardrail')
			expect(result.result).toBe(action === 'block' ? '' : 'Redacted')
		},
	)

	it.each(['native', 'unknown'] as const)(
		'rejects unsupported %s retention before making a provider request',
		async (kind) => {
			const f = fixture([output(2)])
			await expect(
				run(f, {
					structuredOutput: {
						schema: scoreSchema,
						...(kind === 'native' ? { mode: 'native' as const } : {}),
						toolResultRetention: kind === 'native' ? 'durable' : ('other' as 'durable'),
					},
				}),
			).rejects.toThrow()
			expect(f.provider.requests).toHaveLength(0)
		},
	)

	it('fails honestly above the session-record ceiling without publishing the candidate', async () => {
		const text = 'x'.repeat(4_500_000)
		const f = fixture([output(2, 'oversized')])
		const hook = postHook({ action: 'replace', output: JSON.stringify({ score: 2, text }) })
		await expect(
			run(f, {
				maxToolOutputChars: 100,
				pluginManager: hook.pluginManager,
			}),
		).rejects.toThrow(/record.*limit/i)
		expect(f.provider.requests).toHaveLength(1)
		expect(
			(await terminalRecords(f.params.sessionLog)).every(
				(record) =>
					record.type !== 'turn_completed' || record.settlement.structuredOutput === undefined,
			),
		).toBe(true)
	})
})
