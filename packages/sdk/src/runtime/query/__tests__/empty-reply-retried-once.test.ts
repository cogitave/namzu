import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { testToolset } from '../../../test-support/toolset.js'
import { createEvidenceRecallStep } from '../../../turn/evidence-recall.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import { REASONING_ONLY_MESSAGE } from '../turn/stall-monitor.js'

/**
 * A main-step reply with no text, no reasoning and no call that the provider
 * calls a normal stop is asked for once more with the same request, once.
 */

const SESSION = 'de211f59-a613-4afc-a60b-044224636dc3' as SessionId
const PROJECT = '013d6892-222f-41f6-84ea-144d389a3633' as ProjectId
const TENANT = '09baa4c3-d377-42ba-80c6-b90340766578' as TenantId

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

interface Step {
	readonly text?: string
	readonly toolCall?: boolean
	readonly reasoning?: string
	readonly finishReason?: 'stop' | 'length'
}

const usage = {
	promptTokens: 10,
	completionTokens: 5,
	totalTokens: 15,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

const isLookup = (p: ChatCompletionParams) =>
	JSON.stringify(p.messages).includes('Do not answer the question or call tools')

function scripted(steps: readonly Step[]) {
	// \`requests\` holds main-step requests only; the history lookup the kernel
	// makes at the start of a turn with history is answered on its own and kept apart.
	const requests: ChatCompletionParams[] = []
	const lookups: ChatCompletionParams[] = []
	let index = 0
	const provider = {
		id: 'scripted',
		name: 'Scripted',
		requests,
		lookups,
		async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			if (isLookup(params)) {
				lookups.push(params)
				yield { id: 'l', delta: { content: '{"mode":"direct"}' } }
				yield { id: 'l', delta: {}, finishReason: 'stop', usage }
				return
			}
			requests.push(params)
			const step = steps[Math.min(index++, steps.length - 1)] as Step
			if (step.toolCall)
				yield {
					id: 's',
					delta: {
						toolCalls: [
							{ index: 0, id: `c${index}`, function: { name: 'observe', arguments: '{}' } },
						],
					},
				}
			if (step.reasoning)
				yield { id: 's', delta: { reasoning: { index: 0, text: step.reasoning } } }
			if (step.text) yield { id: 's', delta: { content: step.text } }
			yield { id: 's', delta: {}, finishReason: step.finishReason ?? 'stop', usage }
		},
	}
	return provider as unknown as LLMProvider & {
		requests: ChatCompletionParams[]
		lookups: ChatCompletionParams[]
	}
}

async function run(provider: LLMProvider, history = false) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-empty-'))
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
			},
			agentId: 'agent_e',
			agentName: 'Empty',
			messages: history
				? [
						createUserMessage('look at the first thing'),
						createAssistantMessage('the first thing was looked at'),
						createUserMessage('do the thing'),
					]
				: [createUserMessage('do the thing')],
			workingDirectory,
			sessionId: SESSION,
			topicId: 'deff1264-c6c8-426e-b259-3409cefb8929' as TopicId,
			projectId: PROJECT,
			tenantId: TENANT,
			...(history
				? {
						// The host-wired history lookup: it asks the model to plan a search.
						prepareStep: createEvidenceRecallStep({
							scope: { tenantId: TENANT, projectId: PROJECT, sessionId: SESSION },
							resolveQuery: true,
							maxChars: 6000,
							retrieve: async () => ({ candidates: [], scannedBytes: 0, incomplete: false }),
						}),
					}
				: {}),
			retry: false,
		},
		() => {},
	)
}

const wire = (p: { requests: ChatCompletionParams[] }, i: number) =>
	JSON.stringify(p.requests[i]?.messages.map((m) => [m.role, m.content]))

describe('an empty reply that is a normal stop', () => {
	it('is asked for once more with the same request, then completes', async () => {
		const provider = scripted([{}, { text: 'the answer' }])
		const turn = await run(provider)
		expect(turn.result).toBe('the answer')
		expect(provider.requests).toHaveLength(2)
		expect(wire(provider, 1)).toBe(wire(provider, 0))
		expect(turn.lastError).toBeUndefined()
	})

	it('adds the usage of the discarded attempt to the turn', async () => {
		const provider = scripted([{}, { text: 'the answer' }])
		const turn = await run(provider)
		expect(turn.tokenUsage.promptTokens).toBe(20)
		expect(turn.tokenUsage.completionTokens).toBe(10)
		expect(turn.steps).toHaveLength(2)
		expect(wire(provider, 1)).toBe(wire(provider, 0))
	})

	it('ends with a plain message, after the closing request, when it stays empty', async () => {
		const provider = scripted([{}])
		const turn = await run(provider)
		// Two attempts, then the closing request the turn always made.
		expect(provider.requests).toHaveLength(3)
		expect(turn.lastError ?? '').toContain('empty reply twice')
	})

	it('is not retried when the reply was cut at the output allowance', async () => {
		const provider = scripted([{ finishReason: 'length' }])
		await run(provider)
		// The original request and the closing one the turn always made: no third.
		expect(provider.requests).toHaveLength(2)
		expect(wire(provider, 1)).not.toBe(wire(provider, 0))
	})

	it('leaves a reply of reasoning only to its own path, which adds a nudge', async () => {
		const provider = scripted([{ reasoning: 'thinking' }, { text: 'the answer' }])
		const turn = await run(provider)
		expect(turn.result).toBe('the answer')
		expect(provider.requests).toHaveLength(2)
		const nudged = provider.requests[1]?.messages.some((m) => m.content === REASONING_ONLY_MESSAGE)
		expect(nudged).toBe(true)
	})

	it('is counted on main-step requests only when the turn has history', async () => {
		const provider = scripted([{}, { text: 'the answer' }])
		const turn = await run(provider, true)
		expect(turn.result).toBe('the answer')
		// One history lookup, answered on its own; two main requests.
		expect(provider.lookups).toHaveLength(1)
		expect(provider.requests).toHaveLength(2)
		expect(wire(provider, 1)).toBe(wire(provider, 0))
	})

	it('is armed again after a tool call: an empty reply later is asked for once more', async () => {
		const provider = scripted([{}, { toolCall: true }, {}, { text: 'the answer' }])
		const turn = await run(provider)
		expect(turn.result).toBe('the answer')
		// empty, retry (tool call), empty, retry (answer)
		expect(provider.requests).toHaveLength(4)
		expect(turn.lastError).toBeUndefined()
	})

	it('is asked for only once in a row, not once per empty reply', async () => {
		const provider = scripted([{}, {}, { text: 'the answer' }])
		await run(provider)
		// Two empties, then the closing request the turn always makes.
		expect(provider.requests).toHaveLength(3)
	})
})
