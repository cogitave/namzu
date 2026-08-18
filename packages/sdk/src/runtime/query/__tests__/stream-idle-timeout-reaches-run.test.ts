import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

class GenericAbortStallProvider implements LLMProvider {
	readonly id: string
	readonly name: string
	calls = 0
	readonly transportSignals: AbortSignal[] = []

	constructor(id = 'idle-primary') {
		this.id = id
		this.name = id
	}

	chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.calls += 1
		const signal = params.signal
		if (!signal) throw new Error('query did not give the provider a transport signal')
		this.transportSignals.push(signal)

		return {
			[Symbol.asyncIterator]() {
				return {
					next: () =>
						new Promise<IteratorResult<StreamChunk>>((_resolve, reject) => {
							signal.addEventListener(
								'abort',
								() => reject(Object.assign(new Error('transport aborted'), { name: 'AbortError' })),
								{ once: true },
							)
						}),
					return: async () => ({ done: true, value: undefined }),
				}
			},
		}
	}
}

function baseParams(provider: LLMProvider, workingDirectory: string, caller: AbortController) {
	return {
		provider,
		tools: new ToolRegistry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 5_000,
			streamIdleTimeoutMs: 10,
			tokenBudget: 100_000,
			maxIterations: 1,
			maxResponseTokens: 256,
		},
		agentId: 'agent_idle_bound',
		agentName: 'Idle Bound Agent',
		messages: [createUserMessage('answer once')],
		workingDirectory,
		sessionId: 'ses_idle_bound' as SessionId,
		topicId: 'top_idle_bound' as TopicId,
		projectId: 'prj_idle_bound' as ProjectId,
		tenantId: 'tnt_idle_bound' as TenantId,
		signal: caller.signal,
	}
}

describe('the provider idle bound reaches a real query', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	async function workdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-stream-idle-'))
		workdirs.push(dir)
		return dir
	}

	it('settles a stalled run as a network failure and closes its transport', async () => {
		const provider = new GenericAbortStallProvider()
		const caller = new AbortController()
		const events: RunEvent[] = []
		const safety = setTimeout(
			() => caller.abort(new Error('test safety bound: production watchdog did not settle')),
			1_000,
		)
		try {
			const run = await drainQuery(
				{
					...baseParams(provider, await workdir(), caller),
					retry: false,
				},
				(event) => {
					events.push(event)
				},
			)

			expect(run.status).toBe('failed')
			expect(run.lastProviderError).toMatchObject({
				kind: 'network',
				providerId: 'idle-primary',
				detail: expect.stringContaining('10ms'),
			})
			expect(events.find((event) => event.type === 'run_failed')).toMatchObject({
				type: 'run_failed',
				providerError: run.lastProviderError,
			})
			expect(provider.transportSignals).toHaveLength(1)
			expect(provider.transportSignals[0]?.aborted).toBe(true)
			expect(provider.transportSignals[0]?.reason).toMatchObject({
				name: 'ProviderRequestError',
				kind: 'network',
			})
			expect(caller.signal.aborted).toBe(false)
		} finally {
			clearTimeout(safety)
			if (!caller.signal.aborted) caller.abort(new Error('test cleanup'))
		}
	})

	it('keeps the idle cause through generic AbortError, retries, then falls over', async () => {
		const primary = new GenericAbortStallProvider()
		const fallback = new MockLLMProvider({ turns: [{ text: 'fallback answered' }] })
		const caller = new AbortController()
		const events: RunEvent[] = []
		const safety = setTimeout(
			() => caller.abort(new Error('test safety bound: recovery did not settle')),
			1_000,
		)
		try {
			const run = await drainQuery(
				{
					...baseParams(primary, await workdir(), caller),
					retry: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
					fallbackProviders: [{ provider: fallback, model: 'fallback-model' }],
				},
				(event) => {
					events.push(event)
				},
			)

			expect(run.status).toBe('completed')
			expect(run.result).toBe('fallback answered')
			expect(primary.calls).toBe(2)
			expect(primary.transportSignals).toHaveLength(2)
			expect(primary.transportSignals.every((signal) => signal.aborted)).toBe(true)
			expect(fallback.requests).toHaveLength(1)
			expect(events.find((event) => event.type === 'provider_fallback')).toMatchObject({
				type: 'provider_fallback',
				fromProviderId: 'idle-primary',
				toProviderId: fallback.id,
				code: 'network',
			})
			expect(events.some((event) => event.type === 'run_failed')).toBe(false)
			expect(caller.signal.aborted).toBe(false)
		} finally {
			clearTimeout(safety)
			if (!caller.signal.aborted) caller.abort(new Error('test cleanup'))
		}
	})

	it('refuses a malformed idle bound before a provider call', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const caller = new AbortController()
		const params = baseParams(provider, await workdir(), caller)

		await expect(
			drainQuery({
				...params,
				runConfig: {
					...params.runConfig,
					streamIdleTimeoutMs: Number.NaN,
				},
			}),
		).rejects.toThrow(/streamIdleTimeoutMs must be an integer/)
		expect(provider.requests).toHaveLength(0)
	})
})
