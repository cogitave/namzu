import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { HttpEmbeddingProvider } from '../../../rag/embedding.js'
import { DefaultKnowledgeBase } from '../../../rag/knowledge-base.js'
import { createRAGTool } from '../../../rag/rag-tool.js'
import { InMemoryVectorStore } from '../../../rag/vector-store.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * The executor has always produced a per-tool abort signal, but the RAG tool
 * dropped it before `KnowledgeBase.query`. A stopped run therefore detached
 * after its own wait bound while the owned embedding request kept running.
 * This drives the public tool through every production composition layer and
 * observes the transport, not merely one forwarding helper.
 */

describe('RAG embedding cancellation reaches a real run', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		vi.unstubAllGlobals()
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('stops the embedding transport with the caller cause', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-rag-cancel-'))
		workdirs.push(workingDirectory)

		let markStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let transportSignal: AbortSignal | undefined
		const fetchMock = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					transportSignal = init.signal as AbortSignal
					transportSignal.addEventListener(
						'abort',
						() =>
							reject(Object.assign(new Error('generic transport abort'), { name: 'AbortError' })),
						{ once: true },
					)
					markStarted?.()
				}),
		)
		vi.stubGlobal('fetch', fetchMock)

		const tenantId = 'tnt_rag_cancel' as TenantId
		const knowledgeBase = new DefaultKnowledgeBase(
			{ name: 'run knowledge', tenantId },
			new InMemoryVectorStore(),
			new HttpEmbeddingProvider({
				apiKey: 'k',
				model: 'embedding-model',
				baseUrl: 'https://embeddings.test/v1',
				requestTimeoutMs: 60_000,
			}),
		)
		const tools = new ToolRegistry()
		tools.register(
			createRAGTool({
				knowledgeBases: new Map([[knowledgeBase.id, knowledgeBase]]),
				defaultKnowledgeBaseId: knowledgeBase.id,
			}),
		)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ id: 'call_rag', name: 'knowledge_search', args: { query: 'where is it?' } },
					],
					finishReason: 'tool_calls',
				},
				{ text: 'the run must not need another model turn' },
			],
		})
		const caller = new AbortController()
		const pending = drainQuery({
			provider,
			tools,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 10_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
				permissionMode: 'auto',
			},
			toolTimeoutMs: 60_000,
			agentId: 'agent_rag_cancel',
			agentName: 'RAG Cancellation',
			messages: [createUserMessage('search the knowledge base')],
			workingDirectory,
			sessionId: 'ses_rag_cancel' as SessionId,
			topicId: 'top_rag_cancel' as TopicId,
			projectId: 'prj_rag_cancel' as ProjectId,
			tenantId,
			signal: caller.signal,
		})

		await started
		const reason = new Error('operator stopped knowledge retrieval')
		caller.abort(reason)
		let safetyTimer: ReturnType<typeof setTimeout> | undefined
		const safety = new Promise<never>((_resolve, reject) => {
			safetyTimer = setTimeout(
				() => reject(new Error('RAG cancellation did not settle the run')),
				1_000,
			)
		})
		const run = await Promise.race([pending, safety]).finally(() => {
			if (safetyTimer !== undefined) clearTimeout(safetyTimer)
		})

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(provider.requests).toHaveLength(1)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(transportSignal).toBeDefined()
		expect(transportSignal).not.toBe(caller.signal)
		expect(transportSignal?.aborted).toBe(true)
		expect(transportSignal?.reason).toBe(reason)
	})
})
