import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	type ChatCompletionParams,
	InMemoryRunStore,
	type LLMProvider,
	MockLLMProvider,
	type StreamChunk,
	ToolRegistry,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { LiveAgent } from './LiveAgent.js'
import { LiveSession } from './LiveSession.js'
import { NamzuModel, type NamzuQueryConfig } from './NamzuModel.js'

const tempDirs: string[] = []

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function makeConfig(
	provider: LLMProvider,
	overrides: Partial<NamzuQueryConfig> = {},
): Promise<{ config: NamzuQueryConfig; store: InMemoryRunStore }> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-live-'))
	tempDirs.push(workingDirectory)
	const store = new InMemoryRunStore()
	const config = {
		agentId: 'agent_live',
		agentName: 'Live agent',
		projectId: 'project_live',
		provider,
		resumeHandler: async () => ({ action: 'continue' as const }),
		runConfig: {
			maxIterations: 4,
			maxResponseTokens: 512,
			model: 'test-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
		},
		runStore: store,
		sessionId: 'session_live',
		tenantId: 'tenant_live',
		tools: new ToolRegistry(),
		topicId: 'topic_live',
		workingDirectory,
		...overrides,
	} as unknown as NamzuQueryConfig
	return { config, store }
}

describe('NamzuModel', () => {
	it('maps live history and instructions into query and returns usage through LiveSession', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{
					chunkSize: 3,
					text: 'Merhaba',
					usage: {
						cacheWriteTokens: 1,
						cachedTokens: 2,
						completionTokens: 3,
						promptTokens: 8,
						totalTokens: 11,
					},
				},
			],
		})
		const { config } = await makeConfig(provider)
		const model = new NamzuModel({ createQueryParams: () => config })
		const session = new LiveSession()
		await session.start(new LiveAgent({ instructions: 'Kısa cevap ver', model }))

		const result = await session.run({ userInput: 'Selam' }).wait()

		expect(result.message?.content).toBe('Merhaba')
		expect(result.usage).toEqual({
			cacheCreationTokens: 1,
			completionTokens: 3,
			promptCachedTokens: 2,
			promptTokens: 8,
			totalTokens: 11,
		})
		expect(provider.requests).toHaveLength(1)
		expect(provider.requests[0]?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					content: expect.stringContaining('Kısa cevap ver'),
					role: 'system',
				}),
				expect.objectContaining({ content: 'Selam', role: 'user' }),
			]),
		)
		await session.close()
	})

	it('keeps Namzu as the sole tool executor and runs a model tool exactly once', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ args: { key: 'x' }, name: 'lookup' }] },
				{ text: 'tool result handled' },
			],
		})
		const { config } = await makeConfig(provider)
		let executions = 0
		config.tools.register({
			description: 'look up a value',
			execute: async () => {
				executions++
				return { output: 'value', success: true }
			},
			inputSchema: z.object({ key: z.string() }),
			name: 'lookup',
		})
		const session = new LiveSession()
		await session.start(
			new LiveAgent({
				instructions: 'Use tools when needed',
				model: new NamzuModel({ createQueryParams: () => config }),
			}),
		)

		const result = await session.run({ userInput: 'find it' }).wait()

		expect(result.message?.content).toBe('tool result handled')
		expect(executions).toBe(1)
		expect(provider.requests).toHaveLength(2)
		await session.close()
	})

	it.each([
		['output guardrails', { outputGuardrails: [vi.fn()] }],
		['answer review', { reviewAnswer: vi.fn() }],
		['structured output', { structuredOutput: { schema: z.object({ answer: z.string() }) } }],
	] as const)('refuses unsafe %s before provider work', async (_name, override) => {
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const { config } = await makeConfig(provider, override as Partial<NamzuQueryConfig>)
		const session = new LiveSession()
		await session.start(
			new LiveAgent({
				instructions: 'test',
				model: new NamzuModel({ createQueryParams: () => config }),
			}),
		)

		await expect(session.run({ userInput: 'hello' }).wait()).rejects.toMatchObject({
			code: 'unsafe_query_config',
		})
		expect(provider.requests).toHaveLength(0)
		await session.close()
	})

	it('does not replay a partially failed Namzu query', async () => {
		const provider = new MockLLMProvider({
			turns: [{ chunkSize: 2, text: 'partial answer', throwAfterChunks: 1 }],
		})
		const { config } = await makeConfig(provider, { retry: false })
		const session = new LiveSession()
		await session.start(
			new LiveAgent({
				instructions: 'test',
				model: new NamzuModel({ createQueryParams: () => config }),
			}),
		)

		await expect(session.run({ userInput: 'hello' }).wait()).rejects.toMatchObject({
			code: 'run_not_speakable',
		})
		expect(provider.requests).toHaveLength(1)
		await session.close()
	})

	it('drains cancellation into a terminal cancelled SDK run', async () => {
		let started!: () => void
		const providerStarted = new Promise<void>((resolve) => {
			started = resolve
		})
		const provider: LLMProvider = {
			id: 'blocking',
			name: 'Blocking provider',
			async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				const signal = params.signal
				if (!signal) throw new Error('query omitted its transport signal')
				started()
				yield { delta: { content: 'partial' }, id: 'blocking' }
				if (!signal.aborted) {
					await new Promise<void>((resolve) =>
						signal.addEventListener('abort', () => resolve(), { once: true }),
					)
				}
			},
		}
		const { config, store } = await makeConfig(provider, { retry: false })
		const session = new LiveSession({ closeTimeoutMs: 500 })
		await session.start(
			new LiveAgent({
				instructions: 'test',
				model: new NamzuModel({ createQueryParams: () => config }),
			}),
		)
		const turn = session.run({ userInput: 'hello' })
		await providerStarted

		turn.interrupt('test cancellation')

		await expect(turn.wait()).resolves.toMatchObject({ status: 'interrupted' })
		expect(store.snapshot().meta).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' })
		await session.close()
	})
})
