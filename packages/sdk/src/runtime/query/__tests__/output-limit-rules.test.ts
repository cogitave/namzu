import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import {
	AUTO_CONTINUATION_USER_MESSAGE,
	REASONING_CUT_USER_MESSAGE,
} from '../../../constants/continuation.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * Output-limit rules: a cap on continuation nudges (opt-in), a shorter-think
 * nudge for a cut during reasoning, and one retry with a smaller output cap
 * when prompt plus cap passed the window.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function run(
	provider: MockLLMProvider,
	extra: { maxOutputContinuations?: number; maxIterations?: number } = {},
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-outlimit-'))
	dirs.push(workingDirectory)
	return drainQuery({
		provider,
		toolsets: [],
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 20_000,
			tokenBudget: 500_000,
			maxIterations: extra.maxIterations ?? 12,
			maxResponseTokens: 20_000,
		},
		agentId: 'agent_o',
		agentName: 'OutLimit',
		messages: [createUserMessage('write a lot')],
		workingDirectory,
		sessionId: 'de211f59-a613-4afc-a60b-044224636dc3' as SessionId,
		topicId: 'deff1264-c6c8-426e-b259-3409cefb8929' as TopicId,
		projectId: '013d6892-222f-41f6-84ea-144d389a3633' as ProjectId,
		tenantId: '09baa4c3-d377-42ba-80c6-b90340766578' as TenantId,
		retry: false,
		...(extra.maxOutputContinuations !== undefined
			? { maxOutputContinuations: extra.maxOutputContinuations }
			: {}),
	})
}

const cut = { text: 'partial ', finishReason: 'length' as const }

describe('continuation after an output-limit cut', () => {
	it('without a cap keeps nudging, as before', async () => {
		const provider = new MockLLMProvider({
			turns: [cut, cut, cut, cut, cut, { text: 'done' }],
		})
		const result = await run(provider)
		expect(provider.requests).toHaveLength(6)
		expect(result.stopReason).toBe('end_turn')
	})

	it('with a cap of 3 sends three nudges, then stops with an error', async () => {
		const provider = new MockLLMProvider({ turns: [cut] })
		const result = await run(provider, { maxOutputContinuations: 3 })
		// First call plus three nudged calls.
		expect(provider.requests).toHaveLength(4)
		expect(
			provider.requests[3]?.messages.filter((m) => m.content === AUTO_CONTINUATION_USER_MESSAGE),
		).toHaveLength(3)
		expect(result.stopReason).toBe('output_limit')
		expect(result.lastError ?? '').toMatch(/output limit/)
	})

	it('a call that finishes on its own restarts the count', async () => {
		const provider = new MockLLMProvider({
			turns: [cut, cut, { text: 'ok', toolCalls: [] }],
		})
		const result = await run(provider, { maxOutputContinuations: 3 })
		expect(result.stopReason).toBe('end_turn')
	})

	it('continues an empty output cutoff even when the provider exposes no reasoning', async () => {
		const provider = new MockLLMProvider({
			turns: [{ finishReason: 'length' }, { text: 'Recovered answer' }],
		})
		const result = await run(provider, { maxOutputContinuations: 3 })
		expect(provider.requests).toHaveLength(2)
		expect(
			provider.requests[1]?.messages.some((m) => m.content === REASONING_CUT_USER_MESSAGE),
		).toBe(true)
		expect(provider.requests[1]?.toolChoice).not.toBe('none')
		expect(result.result).toBe('Recovered answer')
		expect(result.stopReason).toBe('end_turn')
	})

	it.each([0, 3])('bounds repeated empty cutoffs with the configured cap %i', async (cap) => {
		const provider = new MockLLMProvider({ turns: [{ finishReason: 'length' }] })
		const result = await run(provider, { maxOutputContinuations: cap })
		expect(provider.requests).toHaveLength(cap + 1)
		expect(result.stopReason).toBe('output_limit')
		expect(result.lastError).toMatch(/output limit/)
	})

	it('keeps the legacy empty-completion fallback when no bounded continuation was requested', async () => {
		const provider = new MockLLMProvider({ turns: [{ finishReason: 'length' }] })
		await run(provider)
		expect(provider.requests).toHaveLength(2)
		expect(
			provider.requests[1]?.messages.some(
				(m) =>
					m.role === 'user' &&
					m.source?.type === 'runtime-context' &&
					m.source.kind === 'auto-continuation',
			),
		).toBe(false)
	})

	it('a cut during reasoning gets the shorter-think nudge', async () => {
		let calls = 0
		class ReasoningCut extends MockLLMProvider {
			override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				calls++
				if (calls === 1) {
					this.requests.push(params)
					yield { id: 'r1', delta: { reasoning: { index: 0, type: 'thinking', text: 'hmm…' } } }
					yield {
						id: 'r1',
						delta: {},
						finishReason: 'length',
						usage: {
							promptTokens: 1,
							completionTokens: 1,
							totalTokens: 2,
							cachedTokens: 0,
							cacheWriteTokens: 0,
						},
					}
					return
				}
				yield* super.chatStream(params)
			}
		}
		const provider = new ReasoningCut({ turns: [{ text: 'brief answer' }] })
		const result = await run(provider, { maxOutputContinuations: 3 })
		const second = provider.requests[1]
		expect(second?.messages.some((m) => m.content === REASONING_CUT_USER_MESSAGE)).toBe(true)
		expect(second?.messages.some((m) => m.content === AUTO_CONTINUATION_USER_MESSAGE)).toBe(false)
		expect(result.stopReason).toBe('end_turn')
	})
})

describe('an output cap that does not fit beside the prompt', () => {
	function overflow(maxTokensSeen: Array<number | undefined>, mode: 'once' | 'always') {
		let n = 0
		return class extends MockLLMProvider {
			override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				maxTokensSeen.push(params.maxTokens)
				n++
				if (mode === 'always' || n === 1) {
					throw Object.assign(
						new Error(
							'input length and `max_tokens` exceed context limit: 170000 + 20000 > 180000, decrease input length or `max_tokens` and try again',
						),
						{ status: 400 },
					)
				}
				yield* super.chatStream(params)
			}
		}
	}

	it('retries once with window - input - 1000', async () => {
		const seen: Array<number | undefined> = []
		const Provider = overflow(seen, 'once')
		const result = await run(new Provider({ turns: [{ text: 'fits now' }] }))
		expect(seen).toEqual([20_000, 9_000])
		expect(result.result).toBe('fits now')
	})

	it('does not retry when the room left is below the floor', async () => {
		const seen: Array<number | undefined> = []
		class Tight extends MockLLMProvider {
			override chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				seen.push(params.maxTokens)
				throw Object.assign(
					new Error('input length and `max_tokens` exceed context limit: 178500 + 20000 > 180000'),
					{ status: 400 },
				)
			}
		}
		const result = await run(new Tight({}))
		expect(seen).toHaveLength(1)
		expect(result.status).toBe('failed')
	})

	it('does not loop when the smaller cap overflows again', async () => {
		const seen: Array<number | undefined> = []
		const Provider = overflow(seen, 'always')
		const result = await run(new Provider({}))
		expect(seen).toEqual([20_000, 9_000])
		expect(result.status).toBe('failed')
	})
})
