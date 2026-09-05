import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	CompactionConfigSchema,
	type ProjectId,
	type Run,
	RunCancelled,
	type RunEvent,
	type SessionId,
	type TenantId,
	ToolRegistry,
	type TopicId,
	createUserMessage,
	drainQuery,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureUuid } from '../../../../sdk/src/test-support/ids.js'

import { OpenRouterProvider } from '../client.js'

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

function modelListing(model?: { id: string; contextWindow: number }): Response {
	return {
		ok: true,
		status: 200,
		json: async () => ({
			data: model
				? [
						{
							id: model.id,
							name: model.id,
							context_length: model.contextWindow,
						},
					]
				: [],
		}),
	} as Response
}

describe('context-window cancellation reaches the query transport', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		vi.unstubAllGlobals()
		await Promise.all(workdirs.map((dir) => rm(dir, { recursive: true, force: true })))
		workdirs = []
	})

	it('settles before a non-cooperative model-list fetch and aborts that fetch with the caller reason', async () => {
		const fetchStarted = deferred<void>()
		const releaseFetch = deferred<Response>()
		let transportSignal: AbortSignal | undefined
		vi.stubGlobal(
			'fetch',
			vi.fn((_input: string | URL | Request, init?: RequestInit) => {
				transportSignal = init?.signal ?? undefined
				fetchStarted.resolve()
				// Intentionally ignore abort and remain pending. OpenRouter still
				// has to forward the signal to the transport, while query() must
				// not make settlement depend on a provider obeying it.
				return releaseFetch.promise
			}),
		)

		const provider = new OpenRouterProvider({
			apiKey: 'test-key',
			baseUrl: 'https://example.test/api/v1',
		})
		const chatStream = vi.spyOn(provider, 'chatStream')
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-openrouter-preflight-'))
		workdirs.push(workingDirectory)
		const caller = new AbortController()
		const events: RunEvent[] = []
		const running = drainQuery(
			{
				provider,
				tools: new ToolRegistry(),
				runConfig: {
					model: 'vendor/model',
					timeoutMs: 5_000,
					streamIdleTimeoutMs: 100,
					tokenBudget: 10_000,
					maxIterations: 1,
				},
				agentId: 'agent_openrouter_preflight',
				agentName: 'OpenRouter Preflight Agent',
				messages: [createUserMessage('must not reach the model')],
				workingDirectory,
				sessionId: '68f552e8-9c70-4000-b4e2-4cd546851858' as SessionId,
				topicId: '4e28537c-b75e-4c89-9f07-8f1ae4c19b03' as TopicId,
				projectId: '655f15df-d669-4d61-b540-8fcf6f317e6f' as ProjectId,
				tenantId: '5415f8f1-153f-459b-bc55-cd8927c14b22' as TenantId,
				signal: caller.signal,
				retry: false,
			},
			(event) => {
				events.push(event)
			},
		)
		let outcome: { run: Run } | { error: unknown } | undefined
		void running.then(
			(run) => {
				outcome = { run }
			},
			(error: unknown) => {
				outcome = { error }
			},
		)

		await fetchStarted.promise
		const stop = new RunCancelled('user')
		caller.abort(stop)

		let waitFailure: unknown
		try {
			await vi.waitFor(
				() => {
					expect(transportSignal?.aborted).toBe(true)
					expect(transportSignal?.reason).toBe(stop)
				},
				{ timeout: 500, interval: 10 },
			)
			await vi.waitFor(() => expect(outcome).toBeDefined(), {
				timeout: 1_000,
				interval: 10,
			})
		} catch (err) {
			waitFailure = err
		} finally {
			// Release the hostile transport so either mutation fails with the
			// assertion above and still leaves no async work behind.
			releaseFetch.resolve(modelListing())
		}

		const run = await running
		if (waitFailure) throw waitFailure
		if (outcome && 'error' in outcome) throw outcome.error
		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(chatStream).not.toHaveBeenCalled()
		expect([...events].reverse().find((event) => event.type === 'run_completed')).toMatchObject({
			type: 'run_completed',
			stopReason: 'cancelled',
			cancelCause: 'user',
		})
	})

	it('does not let one cancelled query own a concurrent query metadata request', async () => {
		const requests: Array<{
			signal: AbortSignal | undefined
			release: Deferred<Response>
		}> = []
		vi.stubGlobal(
			'fetch',
			vi.fn((_input: string | URL | Request, init?: RequestInit) => {
				const signal = init?.signal ?? undefined
				const release = deferred<Response>()
				requests.push({ signal, release })
				return new Promise<Response>((resolve, reject) => {
					void release.promise.then(resolve)
					const onAbort = () => reject(signal?.reason)
					if (signal?.aborted) onAbort()
					else signal?.addEventListener('abort', onAbort, { once: true })
				})
			}),
		)

		const provider = new OpenRouterProvider({
			apiKey: 'test-key',
			baseUrl: 'https://example.test/api/v1',
		})
		const chatStream = vi.spyOn(provider, 'chatStream').mockImplementation(() =>
			(async function* () {
				yield {
					id: 'answer',
					delta: { content: 'done' },
					finishReason: 'stop' as const,
					usage: {
						promptTokens: 1,
						completionTokens: 1,
						totalTokens: 2,
						cachedTokens: 0,
						cacheWriteTokens: 0,
					},
				}
			})(),
		)
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-openrouter-shared-'))
		workdirs.push(workingDirectory)

		const start = (suffix: 'a' | 'b', caller: AbortController) => {
			const events: RunEvent[] = []
			const running = drainQuery(
				{
					provider,
					tools: new ToolRegistry(),
					runConfig: {
						model: 'vendor/model',
						timeoutMs: 5_000,
						streamIdleTimeoutMs: 100,
						tokenBudget: 10_000,
						maxIterations: 1,
					},
					compactionConfig: {
						...CompactionConfigSchema.parse({}),
						contextWindowTokens: undefined,
					},
					agentId: `agent_openrouter_${suffix}`,
					agentName: `OpenRouter ${suffix.toUpperCase()}`,
					messages: [createUserMessage(`query ${suffix}`)],
					workingDirectory,
					sessionId: fixtureUuid(`ses_openrouter_${suffix}`) as SessionId,
					topicId: fixtureUuid(`top_openrouter_${suffix}`) as TopicId,
					projectId: '91ec879c-c498-43e2-add0-a4a9cea1f488' as ProjectId,
					tenantId: 'ee6ffe96-00db-4735-8530-2670cbe9b282' as TenantId,
					signal: caller.signal,
					retry: false,
				},
				(event) => {
					events.push(event)
				},
			)
			return { events, running }
		}

		const callerA = new AbortController()
		const callerB = new AbortController()
		const a = start('a', callerA)
		await vi.waitFor(() => expect(requests).toHaveLength(1), {
			timeout: 500,
			interval: 10,
		})
		const b = start('b', callerB)

		let admissionFailure: unknown
		try {
			await vi.waitFor(() => expect(requests).toHaveLength(2), {
				timeout: 500,
				interval: 10,
			})
		} catch (err) {
			admissionFailure = err
		}

		const stop = new RunCancelled('user')
		callerA.abort(stop)
		for (const [index, request] of requests.entries()) {
			request.release.resolve(
				modelListing(index === 1 ? { id: 'vendor/model', contextWindow: 1_000_000 } : undefined),
			)
		}

		const [runA, runB] = await Promise.all([a.running, b.running])
		if (admissionFailure) throw admissionFailure
		expect(requests[0]?.signal?.aborted).toBe(true)
		expect(requests[0]?.signal?.reason).toBe(stop)
		expect(requests[1]?.signal?.aborted).toBe(false)
		expect(runA.status).toBe('cancelled')
		expect(runB.status).toBe('completed')
		expect(chatStream).toHaveBeenCalledTimes(1)
		const usage = b.events.filter(
			(event): event is Extract<RunEvent, { type: 'token_usage_updated' }> =>
				event.type === 'token_usage_updated',
		)
		expect(usage).toContainEqual(
			expect.objectContaining({
				windowSource: 'provider',
				contextWindowTokens: 1_000_000,
			}),
		)
	})
})
