import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import {
	FORCED_STEP_MESSAGE,
	REASONING_CAPPED_MESSAGE,
	REASONING_ONLY_MESSAGE,
} from '../turn/stall-monitor.js'

/**
 * A step that spends its reasoning allowance before acting is cut short and the
 * next step must act; a reply of thinking alone is asked for once more.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

interface Step {
	readonly reasoning?: string
	readonly text?: string
	readonly call?: string
}

const usage = {
	promptTokens: 10,
	completionTokens: 5,
	totalTokens: 15,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

function scripted(steps: readonly Step[], levels?: readonly string[]) {
	const requests: ChatCompletionParams[] = []
	let index = 0
	const provider = {
		id: 'scripted',
		name: 'Scripted',
		requests,
		...(levels ? { reasoningEffortLevelsFor: () => levels } : {}),
		async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			requests.push(params)
			const step = steps[Math.min(index++, steps.length - 1)] as Step
			// A long reasoning step arrives in pieces; the cap is checked between them.
			for (let i = 0; i < (step.reasoning?.length ?? 0); i += 400) {
				yield {
					id: 's',
					delta: { reasoning: { index: 0, text: (step.reasoning as string).slice(i, i + 400) } },
				}
			}
			if (step.text) yield { id: 's', delta: { content: step.text } }
			if (step.call) {
				yield {
					id: 's',
					delta: {
						toolCalls: [
							{
								index: 0,
								id: 'call_1',
								type: 'function',
								function: { name: step.call, arguments: '{}' },
							},
						],
					},
				}
				yield { id: 's', delta: { toolCallEnd: { index: 0, id: 'call_1' } } }
			}
			yield {
				id: 's',
				delta: {},
				finishReason: step.call ? 'tool_calls' : 'stop',
				usage,
			}
		},
	}
	return provider as unknown as LLMProvider & { requests: ChatCompletionParams[] }
}

async function run(
	provider: LLMProvider,
	extra: { effort?: 'low' | 'high'; maxTokens?: number } = {},
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-pace-'))
	dirs.push(workingDirectory)
	return drainQuery(
		{
			provider,
			toolsets: [
				testToolset({
					name: 'observe',
					description: 'Return observed work',
					inputSchema: z.object({}),
					execute: async () => ({ success: true, output: 'Observed.' }),
				}),
			],
			turnConfig: {
				model: 'm',
				timeoutMs: 20_000,
				tokenBudget: 500_000,
				maxIterations: 8,
				maxResponseTokens: 2_000,
				effort: extra.effort ?? 'high',
				reasoning: { maxTokens: extra.maxTokens ?? 500 },
			},
			agentId: 'agent_p',
			agentName: 'Pace',
			messages: [createUserMessage('do the thing')],
			workingDirectory,
			sessionId: 'de211f59-a613-4afc-a60b-044224636dc3' as SessionId,
			topicId: 'deff1264-c6c8-426e-b259-3409cefb8929' as TopicId,
			projectId: '013d6892-222f-41f6-84ea-144d389a3633' as ProjectId,
			tenantId: '09baa4c3-d377-42ba-80c6-b90340766578' as TenantId,
			retry: false,
		},
		() => {},
	)
}

const nudges = (provider: { requests: ChatCompletionParams[] }, text: string) =>
	provider.requests.map(
		(r) =>
			r.messages.filter(
				(m) =>
					m.role === 'user' &&
					typeof m.content === 'string' &&
					m.content.includes(text) &&
					m.source?.type === 'runtime-context' &&
					m.source.kind === 'progress-nudge',
			).length,
	)

describe('a step that thinks past its cap', () => {
	it('is cut short, the model is told, and the next step must call a tool at low effort', async () => {
		const provider = scripted(
			[{ reasoning: 'x'.repeat(8_000) }, { call: 'observe' }, { text: 'done' }],
			['low', 'medium', 'high'],
		)
		const turn = await run(provider)

		expect(turn.result).toBe('done')
		expect(provider.requests).toHaveLength(3)
		expect(provider.requests[0]?.toolChoice).not.toBe('required')
		expect(provider.requests[0]?.effort).toBe('high')
		expect(nudges(provider, REASONING_CAPPED_MESSAGE)).toEqual([0, 1, 1])
		// The forced step: a call is required, at low effort, for that step only.
		expect(provider.requests[1]?.toolChoice).toBe('required')
		expect(provider.requests[1]?.effort).toBe('low')
		expect(provider.requests[2]?.toolChoice).not.toBe('required')
		expect(provider.requests[2]?.effort).toBe('high')
	})

	it('keeps the requested effort where the model does not offer low', async () => {
		const provider = scripted(
			[{ reasoning: 'x'.repeat(8_000) }, { call: 'observe' }, { text: 'done' }],
			['medium', 'high'],
		)
		await run(provider)
		expect(provider.requests[1]?.toolChoice).toBe('required')
		expect(provider.requests[1]?.effort).toBe('high')
	})

	it('is not cut short below the cap', async () => {
		const provider = scripted([{ reasoning: 'x'.repeat(100), text: 'done' }])
		const turn = await run(provider)
		expect(turn.result).toBe('done')
		expect(provider.requests).toHaveLength(1)
	})
})

describe('a reply of thinking only', () => {
	it('is asked for once more, and then answered', async () => {
		const provider = scripted([{ reasoning: 'thinking' }, { text: 'the answer' }])
		const turn = await run(provider, { maxTokens: 0 })
		expect(turn.result).toBe('the answer')
		expect(nudges(provider, REASONING_ONLY_MESSAGE)).toEqual([0, 1])
	})

	it('ends with a plain error, not silence, when it stays empty', async () => {
		const provider = scripted([{ reasoning: 'thinking' }])
		const turn = await run(provider, { maxTokens: 0 })
		expect(turn.lastError ?? '').toContain('stopped after thinking')
	})
})

describe('a provider that refuses a forced tool choice', () => {
	it('is not sent one: the step keeps low effort and the instruction travels in words, once', async () => {
		const provider = Object.assign(
			scripted(
				[{ reasoning: 'x'.repeat(8_000) }, { call: 'observe' }, { text: 'done' }],
				['low', 'high'],
			),
			{ acceptsForcedToolChoiceFor: () => false },
		)
		const turn = await run(provider)

		expect(turn.result).toBe('done')
		expect(provider.requests[1]?.toolChoice).not.toBe('required')
		expect(provider.requests[1]?.effort).toBe('low')
		expect(nudges(provider, FORCED_STEP_MESSAGE)).toEqual([0, 1, 0])
		const lastOf = (i: number) => provider.requests[i]?.messages.at(-1)
		expect(lastOf(1)?.content).toBe(FORCED_STEP_MESSAGE)
		// Not recorded: the step after it does not carry it.
		expect(provider.requests[2]?.messages.some((m) => m.content === FORCED_STEP_MESSAGE)).toBe(
			false,
		)
	})

	it('is sent one when it says it accepts', async () => {
		const provider = Object.assign(
			scripted([{ reasoning: 'x'.repeat(8_000) }, { call: 'observe' }, { text: 'done' }]),
			{ acceptsForcedToolChoiceFor: () => true },
		)
		await run(provider)
		expect(provider.requests[1]?.toolChoice).toBe('required')
	})
})
