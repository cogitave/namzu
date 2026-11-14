/**
 * Three things the OpenRouter driver used to drop or leave unsaid, each on the
 * wire shape the vendor documents:
 *
 * 1. The model's own reasoning between the steps of one turn. The driver sent
 *    only `content` and `tool_calls`, so after every tool call the model lost
 *    its train of thought. The guide says to send the assistant message back
 *    with `reasoning_details` unmodified.
 * 2. What a request cost. Every response states `usage.cost`; the driver read
 *    the token counts and ignored it, so a model with no rate row showed zero.
 * 3. Whether a forced tool choice is taken while a DeepSeek model reasons.
 */

import type {
	AssistantMessage,
	ChatCompletionParams,
	Message,
	ProviderRoute,
	StreamChunk,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterProvider } from '../client.js'

afterEach(() => {
	vi.unstubAllGlobals()
})

const MODEL = 'deepseek/deepseek-v4.1-flash-1017'
const ROUTE: ProviderRoute = { providerId: 'openrouter', model: MODEL, chainIndex: 0 }

function frame(delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) {
	return JSON.stringify({
		id: 'gen-1',
		choices: [{ index: 0, delta, finish_reason: finish }],
		...(usage ? { usage } : {}),
	})
}

function stub(frames: string[]): { bodies: Record<string, any>[] } {
	const bodies: Record<string, any>[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)))
			const body = `${frames.map((f) => `data: ${f}\n\n`).join('')}data: [DONE]\n\n`
			return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
		}),
	)
	return { bodies }
}

function provider(): OpenRouterProvider {
	return new OpenRouterProvider({ apiKey: 'k', baseUrl: 'https://example.test/api/v1' })
}

async function run(
	frames: string[],
	params: Partial<ChatCompletionParams> = {},
): Promise<{ chunks: StreamChunk[]; bodies: Record<string, any>[] }> {
	const { bodies } = stub(frames)
	const chunks: StreamChunk[] = []
	for await (const c of provider().chatStream({
		model: MODEL,
		messages: [{ role: 'user', content: 'hi' }],
		...params,
	})) {
		chunks.push(c)
	}
	return { chunks, bodies }
}

const DETAILS = [
	{ type: 'reasoning.text', text: 'First I look', format: 'unknown', index: 0, id: 'r-1' },
]

const TOOL_CALL = {
	id: 'call_1',
	type: 'function' as const,
	function: { name: 'echo', arguments: '{}' },
}

/** A stored assistant step as the kernel would have recorded it from a stream. */
function assistantStep(over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: 'assistant',
		content: null,
		toolCalls: [TOOL_CALL],
		reasoning: [{ type: 'thinking', text: 'First I look at the files' }],
		source: {
			type: 'model',
			...ROUTE,
			replayState: {
				kind: 'namzu-openrouter-reasoning',
				version: 1,
				route: ROUTE,
				details: [{ ...DETAILS[0], text: 'First I look at the files' }],
			},
		},
		...over,
	} as AssistantMessage
}

const user = (content: string): Message => ({ role: 'user', content }) as Message
const toolResult: Message = { role: 'tool', toolCallId: 'call_1', content: 'ok' } as Message

describe('reasoning is kept as the wire sent it', () => {
	it('emits the folded entries as the replay state of the finished response', async () => {
		const { chunks } = await run([
			frame({
				reasoning: 'First I ',
				reasoning_details: [
					{ type: 'reasoning.text', text: 'First I ', format: 'unknown', index: 0, id: 'r-1' },
				],
			}),
			frame({
				reasoning: 'look',
				reasoning_details: [{ type: 'reasoning.text', text: 'look', format: 'unknown', index: 0 }],
			}),
			frame({
				tool_calls: [
					{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{}' } },
				],
			}),
			frame({}, 'tool_calls'),
		])
		const withState = chunks.filter((c) => c.replayState !== undefined)
		expect(withState).toHaveLength(1)
		expect(withState[0]?.replayState).toEqual({
			kind: 'namzu-openrouter-reasoning',
			version: 1,
			route: ROUTE,
			details: [
				{ type: 'reasoning.text', text: 'First I look', format: 'unknown', index: 0, id: 'r-1' },
			],
		})
	})

	it('keeps the flat string of a route that sends no reasoning_details', async () => {
		const { chunks } = await run([
			frame({ reasoning: 'thinking ' }),
			frame({ reasoning: 'hard' }),
			frame({ content: 'x' }),
			frame({}, 'stop'),
		])
		expect(chunks.find((c) => c.replayState !== undefined)?.replayState).toMatchObject({
			reasoning: 'thinking hard',
		})
	})

	it('emits no state when the model did not reason', async () => {
		const { chunks } = await run([frame({ content: 'x' }), frame({}, 'stop')])
		expect(chunks.some((c) => c.replayState !== undefined)).toBe(false)
	})
})

describe('reasoning goes back inside the turn, unmodified', () => {
	it('sends reasoning_details on the step after a tool call', async () => {
		const { bodies } = await run([frame({ content: 'done' }), frame({}, 'stop')], {
			messages: [user('go'), assistantStep(), toolResult],
		})
		expect(bodies).toHaveLength(1)
		const assistant = bodies[0]?.messages[1]
		expect(assistant.reasoning_details).toEqual([
			{
				type: 'reasoning.text',
				text: 'First I look at the files',
				format: 'unknown',
				index: 0,
				id: 'r-1',
			},
		])
		expect(assistant.tool_calls).toHaveLength(1)
		expect(assistant.reasoning).toBeUndefined()
	})

	it('sends a flat state as `reasoning`', async () => {
		const step = assistantStep({
			source: {
				type: 'model',
				...ROUTE,
				replayState: {
					kind: 'namzu-openrouter-reasoning',
					version: 1,
					route: ROUTE,
					reasoning: 'First I look at the files',
				},
			},
		})
		const { bodies } = await run([frame({ content: 'x' }), frame({}, 'stop')], {
			messages: [user('go'), step, toolResult],
		})
		expect(bodies[0]?.messages[1].reasoning).toBe('First I look at the files')
		expect(bodies[0]?.messages[1].reasoning_details).toBeUndefined()
	})

	it('does not resend reasoning from an earlier turn', async () => {
		const { bodies } = await run([frame({ content: 'x' }), frame({}, 'stop')], {
			messages: [user('first'), assistantStep(), toolResult, user('second')],
		})
		expect(bodies[0]?.messages[1].reasoning_details).toBeUndefined()
		expect(bodies[0]?.messages[1].tool_calls).toHaveLength(1)
	})

	it('treats host-generated context as part of the turn, not a new one', async () => {
		const ctx = {
			role: 'user',
			content: 'ctx',
			source: { type: 'runtime-context', kind: 'step-context' },
		} as Message
		const { bodies } = await run([frame({ content: 'x' }), frame({}, 'stop')], {
			messages: [user('go'), assistantStep(), toolResult, ctx],
		})
		expect(bodies[0]?.messages[1].reasoning_details).toHaveLength(1)
	})

	it('sends nothing when the stored reasoning no longer matches the state', async () => {
		const { bodies } = await run([frame({ content: 'x' }), frame({}, 'stop')], {
			messages: [
				user('go'),
				assistantStep({ reasoning: [{ type: 'thinking', text: 'rewritten' }] }),
				toolResult,
			],
		})
		expect(bodies[0]?.messages[1].reasoning_details).toBeUndefined()
	})

	it('sends nothing when the state belongs to another route', async () => {
		const other: ProviderRoute = { providerId: 'openrouter', model: 'other/model', chainIndex: 0 }
		const step = assistantStep({
			source: {
				type: 'model',
				...other,
				replayState: {
					kind: 'namzu-openrouter-reasoning',
					version: 1,
					route: other,
					details: [{ ...DETAILS[0], text: 'First I look at the files' }],
				},
			},
		})
		const { bodies } = await run([frame({ content: 'x' }), frame({}, 'stop')], {
			messages: [user('go'), step, toolResult],
		})
		expect(bodies[0]?.messages[1].reasoning_details).toBeUndefined()
	})

	it('sends nothing for history that has no state', async () => {
		const step = assistantStep()
		const { source: _s, ...bare } = step
		const { bodies } = await run([frame({ content: 'x' }), frame({}, 'stop')], {
			messages: [user('go'), bare as Message, toolResult],
		})
		expect(bodies[0]?.messages[1].reasoning_details).toBeUndefined()
	})
})

describe('the cost the vendor reports', () => {
	const usage = (extra: Record<string, unknown>) => ({
		prompt_tokens: 10,
		completion_tokens: 5,
		total_tokens: 15,
		...extra,
	})

	it('carries usage.cost as the reported cost of the request', async () => {
		const { chunks } = await run([
			frame({ content: 'x' }, 'stop', usage({ cost: 0.00001411, is_byok: false })),
		])
		expect(chunks.find((c) => c.usage)?.usage?.reportedCostUsd).toBe(0.00001411)
	})

	it('keeps a reported zero (a free model) as a real zero', async () => {
		const { chunks } = await run([frame({ content: 'x' }, 'stop', usage({ cost: 0 }))])
		expect(chunks.find((c) => c.usage)?.usage?.reportedCostUsd).toBe(0)
	})

	it.each([[{}], [{ cost: null }], [{ cost: 'a lot' }], [{ cost: -1 }]])(
		'leaves the cost unreported for %j',
		async (extra) => {
			const { chunks } = await run([frame({ content: 'x' }, 'stop', usage(extra))])
			expect(chunks.find((c) => c.usage)?.usage).not.toHaveProperty('reportedCostUsd')
		},
	)

	it('adds the upstream charge of a bring-your-own-key request', async () => {
		const { chunks } = await run([
			frame(
				{ content: 'x' },
				'stop',
				usage({ cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.02 } }),
			),
		])
		expect(chunks.find((c) => c.usage)?.usage?.reportedCostUsd).toBeCloseTo(0.021, 10)
	})

	it('declares that it reports a cost, and does not send the deprecated usage flag', async () => {
		expect(provider().capabilities.reportsRequestCost).toBe(true)
		const { bodies } = await run([frame({ content: 'x' }, 'stop')])
		expect(bodies[0]).not.toHaveProperty('usage')
	})
})

describe('acceptsForcedToolChoiceFor', () => {
	const p = provider()
	it.each([
		['deepseek/deepseek-v4.1-flash-1017', undefined, undefined, false],
		['deepseek/deepseek-v4-pro', { type: 'enabled' as const }, undefined, false],
		['deepseek/deepseek-v4-flash:batch', undefined, 'high' as const, false],
		['deepseek/deepseek-r1-0528', undefined, undefined, false],
		['deepseek/deepseek-v4-flash', { type: 'disabled' as const }, undefined, true],
		['deepseek/deepseek-v4-flash', undefined, 'none' as const, true],
		['deepseek/deepseek-chat', undefined, undefined, true],
		['deepseek/deepseek-v3.2', undefined, undefined, true],
		['deepseek/deepseek-prover-v2', undefined, undefined, true],
		['deepseek/deepseek-reasoner-lite', undefined, undefined, false],
		['deepseek/deepseek-flashy', undefined, undefined, true],
		['deepseek/deepseek-v4-pro-0813', undefined, undefined, false],
		['openai/gpt-5-mini', undefined, undefined, true],
	])('%s %j %j', (model, thinking, effort, expected) => {
		expect(p.acceptsForcedToolChoiceFor(model, thinking, effort)).toBe(expected)
	})

	it('does not put a forced choice on the wire where the model refuses it', async () => {
		const { bodies } = await run([frame({ content: 'x' }, 'stop')], { toolChoice: 'required' })
		expect(bodies).toHaveLength(1)
		expect(bodies[0]).not.toHaveProperty('tool_choice')
	})
})

describe('a listed variant has its base model window', () => {
	it('answers a :batch id the listing lacks from the untagged id', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					data: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'x', context_length: 1_048_576 }],
				}),
			}),
		)
		expect(await provider().resolveContextWindow('deepseek/deepseek-v4.1-flash:nitro')).toBe(
			1_048_576,
		)
	})
})
