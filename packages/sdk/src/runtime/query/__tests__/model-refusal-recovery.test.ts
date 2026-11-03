import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { REFUSED_REPLY_RETRY_MESSAGE } from '../../../constants/continuation.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { drainQuery } from '../index.js'

/**
 * A reply the provider declined to give is not an empty completion. It is
 * recovered once, kept out of the history sent next, and never settles as a
 * finished turn.
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

async function run(
	provider: MockLLMProvider,
	extra: { refusalFallback?: 'auto' | 'off'; maxIterations?: number } = {},
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-refusal-'))
	dirs.push(workingDirectory)
	const events: SessionEvent[] = []
	const turn = await drainQuery(
		{
			provider,
			toolsets: [],
			turnConfig: {
				model: 'primary-model',
				timeoutMs: 20_000,
				tokenBudget: 500_000,
				maxIterations: extra.maxIterations ?? 8,
				maxResponseTokens: 2_000,
			},
			agentId: 'agent_r',
			agentName: 'Refusal',
			messages: [createUserMessage('do the thing')],
			workingDirectory,
			sessionId: 'de211f59-a613-4afc-a60b-044224636dc3' as SessionId,
			topicId: 'deff1264-c6c8-426e-b259-3409cefb8929' as TopicId,
			projectId: '013d6892-222f-41f6-84ea-144d389a3633' as ProjectId,
			tenantId: '09baa4c3-d377-42ba-80c6-b90340766578' as TenantId,
			retry: false,
			...(extra.refusalFallback ? { refusalFallback: extra.refusalFallback } : {}),
		},
		(event) => {
			events.push(event)
		},
	)
	return { turn, events }
}

const refusals = (events: SessionEvent[]) =>
	events.filter(
		(e): e is Extract<SessionEvent, { type: 'model_refusal' }> => e.type === 'model_refusal',
	)

describe('a model that declines to answer', () => {
	it('moves the request to the provider-named model once, and answers there', async () => {
		const provider = new MockLLMProvider({
			refusalFallbackModel: 'fallback-model',
			turns: [refused, { text: 'Here is the answer' }],
		})
		const { turn, events } = await run(provider)

		expect(provider.requests).toHaveLength(2)
		expect(provider.requests[0]?.model).toBe('primary-model')
		expect(provider.requests[1]?.model).toBe('fallback-model')
		// The refused (empty) reply is not sent again.
		expect(
			provider.requests[1]?.messages.some((m) => m.role === 'assistant' && m.content === null),
		).toBe(false)
		expect(turn.stopReason).toBe('end_turn')
		expect(turn.result).toBe('Here is the answer')
		expect(refusals(events)).toMatchObject([
			{
				outcome: 'fallback',
				model: 'primary-model',
				fallbackModel: 'fallback-model',
				category: 'cyber',
				explanation: 'flagged',
			},
		])
		// The turn history never stored the refused reply.
		expect(turn.messages.some((m) => m.role === 'assistant' && !m.content && !m.toolCalls)).toBe(
			false,
		)
	})

	it('is tried on the fallback only once: a second refusal settles refused', async () => {
		const provider = new MockLLMProvider({
			refusalFallbackModel: 'fallback-model',
			turns: [refused],
		})
		const { turn, events } = await run(provider)

		expect(provider.requests).toHaveLength(2)
		expect(turn.stopReason).toBe('refused')
		expect(turn.lastError).toMatch(/declined to answer/)
		expect(refusals(events).map((e) => e.outcome)).toEqual(['fallback', 'declined'])
	})

	it('never settles end_turn, never re-sends a closing request, and stores no empty reply', async () => {
		const provider = new MockLLMProvider({ turns: [refused] })
		const { turn, events } = await run(provider)

		// One request: no empty-completion retry that would be refused again.
		expect(provider.requests).toHaveLength(1)
		expect(turn.stopReason).toBe('refused')
		expect(turn.messages.some((m) => m.role === 'assistant')).toBe(false)
		expect(refusals(events)).toMatchObject([
			{ outcome: 'declined', category: 'cyber', explanation: 'flagged' },
		])
		expect(
			events.some((e) => e.type === 'message_completed' && e.stopReason === 'forced_finalize'),
		).toBe(false)
	})

	it("'off' keeps the model and settles with the plain stop reason", async () => {
		const provider = new MockLLMProvider({
			refusalFallbackModel: 'fallback-model',
			turns: [refused, { text: 'unused' }],
		})
		const { turn, events } = await run(provider, { refusalFallback: 'off' })

		expect(provider.requests).toHaveLength(1)
		expect(turn.stopReason).toBe('refused')
		expect(refusals(events).map((e) => e.outcome)).toEqual(['declined'])
	})

	it('retries once on the same model when partial output exists and nothing else is available', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{
					...refused,
					text: 'Starting to ',
					toolCalls: [{ name: 'writer', args: { path: 'a' } }],
				},
				{ text: 'Done another way' },
			],
		})
		const { turn, events } = await run(provider)

		expect(provider.requests).toHaveLength(2)
		expect(provider.requests[1]?.model).toBe('primary-model')
		const sent = provider.requests[1]?.messages ?? []
		const assistant = sent.find((m) => m.role === 'assistant')
		expect(assistant).toMatchObject({ content: 'Starting to ' })
		// Every call in the stopped reply is answered, as an error that says it did not run.
		const toolResult = sent.find((m) => m.role === 'tool')
		expect(toolResult).toMatchObject({ isError: true })
		expect(String(toolResult?.content)).toMatch(/did not run/)
		expect(
			sent.some(
				(m) =>
					m.role === 'user' &&
					m.content === REFUSED_REPLY_RETRY_MESSAGE &&
					m.source?.type === 'runtime-context' &&
					m.source.kind === 'refusal-retry',
			),
		).toBe(true)
		expect(turn.stopReason).toBe('end_turn')
		expect(turn.result).toBe('Done another way')
		expect(refusals(events).map((e) => e.outcome)).toEqual(['retry'])
	})

	it('allows one same-model retry per turn: a second refusal with partial output settles refused', async () => {
		const provider = new MockLLMProvider({
			turns: [{ ...refused, text: 'partial' }],
		})
		const { turn, events } = await run(provider)

		expect(provider.requests).toHaveLength(2)
		expect(turn.stopReason).toBe('refused')
		expect(refusals(events).map((e) => e.outcome)).toEqual(['retry', 'declined'])
	})
})
