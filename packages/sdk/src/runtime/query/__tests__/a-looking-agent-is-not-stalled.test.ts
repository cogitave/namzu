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
	ThinkingConfig,
} from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import {
	FORCED_STEP_MESSAGE,
	STALL_NUDGE_MESSAGE,
	STALL_REPORT_MESSAGE,
} from '../turn/stall-monitor.js'

/**
 * An agent whose every tool only reads is not stalled for reading: new reads
 * are its progress. The kernel's guards also ask in words, not with a forced
 * tool choice, unless the provider says a forced choice is safe and thinking
 * is off. Providers here are scripted loopbacks; nothing waits on a clock.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const usage = {
	promptTokens: 10,
	completionTokens: 5,
	totalTokens: 15,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** `calls` steps that each call `look` (input from `argsFor`), then one plain answer. */
function scriptedLooks(calls: number, argsFor: (i: number) => string, tool = 'look') {
	const requests: ChatCompletionParams[] = []
	let index = 0
	const provider = {
		id: 'scripted',
		name: 'Scripted',
		requests,
		async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			requests.push(params)
			const i = index++
			if (i >= calls) {
				yield { id: 's', delta: { content: 'the report' } }
				yield { id: 's', delta: {}, finishReason: 'stop', usage }
				return
			}
			yield {
				id: 's',
				delta: {
					toolCalls: [
						{
							index: 0,
							id: `call_${i}`,
							type: 'function',
							function: { name: tool, arguments: argsFor(i) },
						},
					],
				},
			}
			yield { id: 's', delta: { toolCallEnd: { index: 0, id: `call_${i}` } } }
			yield { id: 's', delta: {}, finishReason: 'tool_calls', usage }
		},
	}
	return provider as unknown as LLMProvider & { requests: ChatCompletionParams[] }
}

async function run(
	provider: LLMProvider,
	options: { withEdit?: boolean; thinking?: ThinkingConfig; maxTokens?: number } = {},
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-looking-'))
	dirs.push(workingDirectory)
	return drainQuery(
		{
			provider,
			toolsets: [
				testToolset(
					{
						name: 'look',
						description: 'Read something',
						inputSchema: z.object({ n: z.number() }),
						isReadOnly: () => true,
						execute: async (input: { n: number }) => ({
							success: true,
							output: `Looked at ${input.n}.`,
						}),
					},
					...(options.withEdit
						? [
								{
									name: 'edit',
									description: 'Change something',
									inputSchema: z.object({ n: z.number() }),
									isReadOnly: () => false,
									execute: async () => ({ success: true, output: 'ok' }),
								},
							]
						: []),
				),
			],
			turnConfig: {
				model: 'm',
				timeoutMs: 20_000,
				tokenBudget: 500_000,
				maxIterations: 40,
				maxResponseTokens: 2_000,
				...(options.thinking ? { thinking: options.thinking } : {}),
				...(options.maxTokens !== undefined ? { reasoning: { maxTokens: options.maxTokens } } : {}),
			},
			agentId: 'agent_l',
			agentName: 'Looker',
			messages: [createUserMessage('Survey the code and report how it is laid out.')],
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

const carried = (provider: { requests: ChatCompletionParams[] }, text: string) =>
	provider.requests.filter((r) =>
		r.messages.some((m) => typeof m.content === 'string' && m.content === text),
	).length

const forced = (provider: { requests: ChatCompletionParams[] }) =>
	provider.requests.filter((r) => r.toolChoice === 'required').length

describe('an agent whose tools only read', () => {
	it('is not nudged or forced for 20 distinct reads', async () => {
		const provider = scriptedLooks(20, (i) => JSON.stringify({ n: i }))
		const turn = await run(provider)

		expect(turn.result).toBe('the report')
		expect(provider.requests).toHaveLength(21)
		expect(carried(provider, STALL_REPORT_MESSAGE)).toBe(0)
		expect(carried(provider, STALL_NUDGE_MESSAGE)).toBe(0)
		expect(forced(provider)).toBe(0)
	})

	it('is told to report, not to edit, when it repeats one identical read', async () => {
		const provider = scriptedLooks(20, () => JSON.stringify({ n: 1 }))
		await run(provider)

		expect(carried(provider, STALL_REPORT_MESSAGE)).toBeGreaterThan(0)
		expect(carried(provider, STALL_NUDGE_MESSAGE)).toBe(0)
		expect(forced(provider)).toBe(0)
	})
})

describe('an agent that has an edit tool and only reads', () => {
	it('still gets the edit nudge at step 12', async () => {
		const provider = scriptedLooks(14, (i) => JSON.stringify({ n: i }))
		await run(provider, { withEdit: true })

		expect(carried(provider, STALL_NUDGE_MESSAGE)).toBeGreaterThan(0)
		expect(carried(provider, STALL_REPORT_MESSAGE)).toBe(0)
		// Not on step 12 itself: the 12th reply is the one that is judged.
		const first = provider.requests.findIndex((r) =>
			r.messages.some((m) => m.content === STALL_NUDGE_MESSAGE),
		)
		expect(first).toBe(12)
	})
})

describe('the action step a guard asks for', () => {
	/** Cap at 1 token so every step is cut and the next step is an action step. */
	const capped = () => scriptedWithReasoning()

	function scriptedWithReasoning() {
		const requests: ChatCompletionParams[] = []
		let index = 0
		const provider: Record<string, unknown> = {
			id: 'scripted',
			name: 'Scripted',
			requests,
			async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				requests.push(params)
				const i = index++
				if (i === 0) {
					yield { id: 's', delta: { reasoning: { index: 0, text: 'x'.repeat(400) } } }
					yield { id: 's', delta: { reasoning: { index: 0, text: 'x'.repeat(400) } } }
					yield { id: 's', delta: {}, finishReason: 'stop', usage }
					return
				}
				if (i === 1) {
					yield {
						id: 's',
						delta: {
							toolCalls: [
								{
									index: 0,
									id: 'call_1',
									type: 'function',
									function: { name: 'look', arguments: '{"n":1}' },
								},
							],
						},
					}
					yield { id: 's', delta: { toolCallEnd: { index: 0, id: 'call_1' } } }
					yield { id: 's', delta: {}, finishReason: 'tool_calls', usage }
					return
				}
				yield { id: 's', delta: { content: 'done' } }
				yield { id: 's', delta: {}, finishReason: 'stop', usage }
			},
		}
		return provider
	}

	function withAnswer(answer: ((m: string, t?: ThinkingConfig) => boolean) | undefined) {
		const p = capped()
		if (answer) p.acceptsForcedToolChoiceFor = answer
		return p as unknown as LLMProvider & { requests: ChatCompletionParams[] }
	}

	const thinkingOn: ThinkingConfig = { type: 'adaptive' }
	const thinkingOff: ThinkingConfig = { type: 'disabled' }

	it('is asked in words when the provider cannot say', async () => {
		const provider = withAnswer(undefined)
		await run(provider, { withEdit: true, maxTokens: 50 })
		expect(provider.requests).toHaveLength(3)
		expect(forced(provider)).toBe(0)
		expect(carried(provider, FORCED_STEP_MESSAGE)).toBe(1)
	})

	it('is asked in words when the provider says no', async () => {
		const provider = withAnswer(() => false)
		await run(provider, { withEdit: true, maxTokens: 50 })
		expect(forced(provider)).toBe(0)
		expect(carried(provider, FORCED_STEP_MESSAGE)).toBe(1)
	})

	it('is asked in words when the provider says yes but thinking is on', async () => {
		const provider = withAnswer(() => true)
		await run(provider, { withEdit: true, maxTokens: 50, thinking: thinkingOn })
		expect(forced(provider)).toBe(0)
		expect(carried(provider, FORCED_STEP_MESSAGE)).toBe(1)
	})

	it('is forced when the provider says yes and thinking is off', async () => {
		const provider = withAnswer(() => true)
		await run(provider, { withEdit: true, maxTokens: 50, thinking: thinkingOff })
		expect(forced(provider)).toBe(1)
		expect(provider.requests[1]?.toolChoice).toBe('required')
		expect(carried(provider, FORCED_STEP_MESSAGE)).toBe(0)
	})
})
