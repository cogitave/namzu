import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { ProviderRequestError } from '../../../provider/errors.js'
import { MOCK_CAPABILITIES } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import {
	createAssistantMessage,
	createSystemMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

interface Deferred<T> {
	readonly promise: Promise<T>
	resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function longHistory() {
	return [
		createSystemMessage('Keep the old decisions available.'),
		...Array.from({ length: 12 }, (_, index) => [
			createUserMessage(`question ${index} `.repeat(80)),
			createAssistantMessage(`answer ${index} `.repeat(80)),
		]).flat(),
	]
}

const compactionConfig = CompactionConfigSchema.parse({
	contextWindowTokens: 1_000,
	triggerThreshold: 0.1,
	resetThreshold: 0.05,
	keepRecentMessages: 2,
	clearToolResults: false,
	llmVerification: true,
	richStateThreshold: 1_000,
})

function params(
	provider: LLMProvider,
	workingDirectory: string,
	caller: AbortController,
	streamIdleTimeoutMs: number,
) {
	return {
		provider,
		tools: new ToolRegistry(),
		compactionConfig,
		runConfig: {
			model: 'compaction-model',
			timeoutMs: 5_000,
			streamIdleTimeoutMs,
			tokenBudget: 100_000,
			maxIterations: 1,
			maxResponseTokens: 256,
		},
		agentId: 'agent_compaction_bound',
		agentName: 'Compaction Bound Agent',
		messages: longHistory(),
		workingDirectory,
		sessionId: 'ses_compaction_bound' as SessionId,
		topicId: 'top_compaction_bound' as TopicId,
		projectId: 'prj_compaction_bound' as ProjectId,
		tenantId: 'tnt_compaction_bound' as TenantId,
		signal: caller.signal,
	}
}

function completed(content: string): StreamChunk[] {
	return [
		{ id: 'message', delta: { content } },
		{
			id: 'message',
			delta: {},
			finishReason: 'stop',
			usage: {
				promptTokens: 1,
				completionTokens: 1,
				totalTokens: 2,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
		},
	]
}

describe('query-owned compaction verification stays inside the run boundary', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	async function workdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-compaction-verifier-'))
		workdirs.push(dir)
		return dir
	}

	it('closes a pending verifier with the exact run cancellation cause', async () => {
		const started = deferred<void>()
		const release = deferred<void>()
		const transportSignals: Array<AbortSignal | undefined> = []
		let mainCalls = 0
		const provider: LLMProvider = {
			id: 'held-compaction-verifier',
			name: 'Held compaction verifier',
			capabilities: MOCK_CAPABILITIES,
			async *chatStream(request: ChatCompletionParams): AsyncIterable<StreamChunk> {
				const verifier = String(request.messages[0]?.content).includes(
					'context compaction verifier',
				)
				if (!verifier) {
					mainCalls++
					for (const chunk of completed('main should not run')) yield chunk
					return
				}

				transportSignals.push(request.signal)
				started.resolve()
				await new Promise<void>((resolve, reject) => {
					const onAbort = () => reject(request.signal?.reason)
					if (request.signal?.aborted) onAbort()
					else request.signal?.addEventListener('abort', onAbort, { once: true })
					void release.promise.then(resolve)
				})
				for (const chunk of completed('COMPLETE')) yield chunk
			},
		}
		const caller = new AbortController()
		const running = drainQuery({
			...params(provider, await workdir(), caller, 0),
			retry: false,
		})
		let outcome: Awaited<typeof running> | undefined
		void running.then((run) => {
			outcome = run
		})

		await started.promise
		const stop = new Error('operator stopped compaction verification')
		caller.abort(stop)
		let waitFailure: unknown
		try {
			await vi.waitFor(() => expect(outcome).toBeDefined(), {
				timeout: 500,
				interval: 10,
			})
		} catch (error) {
			waitFailure = error
		} finally {
			// A signal-forwarding mutation must fail an assertion without leaving
			// its deliberately hostile verifier behind in the test process.
			release.resolve()
		}

		const run = await running
		if (waitFailure) throw waitFailure
		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(mainCalls).toBe(0)
		expect(transportSignals).toHaveLength(1)
		expect(transportSignals[0]?.aborted).toBe(true)
		expect(transportSignals[0]?.reason).toBe(stop)
	})

	it('does not put an outer idle timer around a legitimate retry backoff', async () => {
		let verifierCalls = 0
		let mainCalls = 0
		const provider: LLMProvider = {
			id: 'recovering-compaction-verifier',
			name: 'Recovering compaction verifier',
			capabilities: MOCK_CAPABILITIES,
			async *chatStream(request: ChatCompletionParams): AsyncIterable<StreamChunk> {
				const verifier = String(request.messages[0]?.content).includes(
					'context compaction verifier',
				)
				if (verifier) {
					verifierCalls++
					if (verifierCalls === 1) {
						throw new ProviderRequestError({
							kind: 'throttle',
							providerId: 'recovering-compaction-verifier',
							retryAfterMs: 40,
						})
					}
					for (const chunk of completed('COMPLETE')) yield chunk
					return
				}

				mainCalls++
				for (const chunk of completed('answer after compaction')) yield chunk
			},
		}
		const caller = new AbortController()
		const run = await drainQuery({
			...params(provider, await workdir(), caller, 10),
			retry: {
				maxRetries: 1,
				initialDelayMs: 0,
				maxDelayMs: 0,
				maxRetryAfterMs: 100,
			},
		})

		expect(run.status).toBe('completed')
		// A history-backed run reports its surviving assistant tail plus the
		// new answer; the proof here is that the post-compaction main call
		// reached the terminal result, not that earlier assistant text vanished.
		expect(run.result).toMatch(/answer after compaction$/)
		expect(verifierCalls).toBe(2)
		expect(mainCalls).toBe(1)
		expect(caller.signal.aborted).toBe(false)
	})
})
