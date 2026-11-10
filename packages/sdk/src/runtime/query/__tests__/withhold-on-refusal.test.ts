import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage, turnContextKey } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { PrepareStep, SessionEvent } from '../../../types/session/index.js'
import { drainQuery } from '../index.js'

/**
 * A refused request that carried recorded memory is re-run once without it,
 * before any model fallback. The history keeps the entries.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const refused: MockTurn = {
	finishReason: 'content_filter',
	refusal: { category: 'cyber', explanation: 'flagged' },
	usage: { promptTokens: 50, completionTokens: 3, totalTokens: 53 },
}

const LINE = '{"id":"mem-1","title":"Cache note","updatedAt":5}'

/** A stage that records one memory entry per request unless the key is withheld. */
const recall: PrepareStep = async ({ withheldKeys }) =>
	withheldKeys?.includes('memory')
		? undefined
		: {
				recordedContext: [
					{
						key: 'memory',
						text: LINE,
						recalledMemories: [
							{ id: 'mem-1', title: 'Cache note', origin: 'derived', updatedAt: 5 },
						],
					},
				],
			}

async function run(
	provider: MockLLMProvider,
	extra: {
		prepareStep?: PrepareStep
		withholdOnRefusal?: readonly string[]
		withheldKeys?: readonly string[]
		refusalFallback?: 'auto' | 'off'
	} = {},
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-withhold-'))
	dirs.push(workingDirectory)
	const events: SessionEvent[] = []
	const turn = await drainQuery(
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
				model: 'primary-model',
				timeoutMs: 20_000,
				tokenBudget: 500_000,
				maxIterations: 8,
				maxResponseTokens: 2_000,
			},
			agentId: 'agent_w',
			agentName: 'Withhold',
			messages: [createUserMessage('do the thing')],
			workingDirectory,
			sessionId: 'de211f59-a613-4afc-a60b-044224636dc3' as SessionId,
			topicId: 'deff1264-c6c8-426e-b259-3409cefb8929' as TopicId,
			projectId: '013d6892-222f-41f6-84ea-144d389a3633' as ProjectId,
			tenantId: '09baa4c3-d377-42ba-80c6-b90340766578' as TenantId,
			retry: false,
			prepareStep: extra.prepareStep ?? recall,
			...(extra.withholdOnRefusal ? { withholdOnRefusal: extra.withholdOnRefusal } : {}),
			...(extra.withheldKeys ? { withheldKeys: extra.withheldKeys } : {}),
			...(extra.refusalFallback ? { refusalFallback: extra.refusalFallback } : {}),
		},
		(event) => {
			events.push(event)
		},
	)
	return { turn, events }
}

const carriesMemory = (request: { messages: readonly { role: string; source?: unknown }[] }) =>
	request.messages.some((m) => turnContextKey(m) === 'memory')

const outcomes = (events: SessionEvent[]) =>
	events.flatMap((e) => (e.type === 'model_refusal' ? [e.outcome] : []))

describe('a refused request that carried recalled memory', () => {
	it('is re-run once without the memory entries, before any fallback', async () => {
		const provider = new MockLLMProvider({
			refusalFallbackModel: 'fallback-model',
			turns: [refused, { text: 'Here is the answer' }],
		})
		const { turn, events } = await run(provider, { withholdOnRefusal: ['memory'] })

		expect(provider.requests).toHaveLength(2)
		expect(carriesMemory(provider.requests[0] as never)).toBe(true)
		expect(carriesMemory(provider.requests[1] as never)).toBe(false)
		// The same model: the fallback was not needed.
		expect(provider.requests[1]?.model).toBe('primary-model')
		expect(turn.stopReason).toBe('end_turn')
		const withheld = events.find((e) => e.type === 'model_refusal' && e.outcome === 'withheld')
		expect(withheld).toMatchObject({ withheldKeys: ['memory'], withheldMemoryIds: ['mem-1'] })
		expect(outcomes(events)).toEqual(['withheld'])
		// The history is not mutated: the entry stays for a later turn.
		expect(turn.messages.some((m) => turnContextKey(m) === 'memory')).toBe(true)
	})

	it('falls through to the existing fallback when the retry is refused too', async () => {
		const provider = new MockLLMProvider({
			refusalFallbackModel: 'fallback-model',
			turns: [refused, refused, { text: 'Answered elsewhere' }],
		})
		const { turn, events } = await run(provider, { withholdOnRefusal: ['memory'] })

		expect(provider.requests.map((r) => r.model)).toEqual([
			'primary-model',
			'primary-model',
			'fallback-model',
		])
		expect(carriesMemory(provider.requests[2] as never)).toBe(false)
		expect(outcomes(events)).toEqual(['withheld', 'fallback'])
		expect(turn.stopReason).toBe('end_turn')
	})

	it('is attempted once: a second refusal settles refused without another withhold', async () => {
		const provider = new MockLLMProvider({ turns: [refused] })
		const { turn, events } = await run(provider, { withholdOnRefusal: ['memory'] })

		expect(provider.requests).toHaveLength(2)
		expect(outcomes(events)).toEqual(['withheld', 'declined'])
		expect(turn.stopReason).toBe('refused')
	})

	it('does nothing when the request carried no entry under the key', async () => {
		const provider = new MockLLMProvider({
			refusalFallbackModel: 'fallback-model',
			turns: [refused, { text: 'ok' }],
		})
		const { events } = await run(provider, {
			withholdOnRefusal: ['memory'],
			prepareStep: async () => undefined,
		})
		expect(outcomes(events)).toEqual(['fallback'])
	})

	it('is off unless the host asks for it', async () => {
		const provider = new MockLLMProvider({
			refusalFallbackModel: 'fallback-model',
			turns: [refused, { text: 'ok' }],
		})
		const { events } = await run(provider)
		expect(outcomes(events)).toEqual(['fallback'])
	})

	it('leaves withheld keys out of the very first request when the host says so', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'fine' }] })
		const { turn } = await run(provider, { withheldKeys: ['memory'] })
		expect(provider.requests).toHaveLength(1)
		expect(carriesMemory(provider.requests[0] as never)).toBe(false)
		expect(turn.stopReason).toBe('end_turn')
	})
})
