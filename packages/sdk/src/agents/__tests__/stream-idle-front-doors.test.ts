import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import type { ReactiveAgentConfig } from '../../types/agent/reactive.js'
import type { SupervisorAgentConfig } from '../../types/agent/supervisor.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { ReactiveAgent } from '../ReactiveAgent.js'
import { SupervisorAgent } from '../SupervisorAgent.js'
import { runAgent } from '../runAgent.js'

class NoRetryStallProvider implements LLMProvider {
	readonly id = 'front-door-stall'
	readonly name = 'Front Door Stall'
	readonly retryDefaults = { maxRetries: 0 }
	calls = 0

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.calls += 1
		const signal = params.signal
		if (!signal) throw new Error('expected a provider transport signal')
		await new Promise<never>((_resolve, reject) => {
			signal.addEventListener(
				'abort',
				() => reject(Object.assign(new Error('transport aborted'), { name: 'AbortError' })),
				{ once: true },
			)
		})
	}
}

const scope = {
	sessionId: 'ses_idle_front' as SessionId,
	topicId: 'top_idle_front' as TopicId,
	projectId: 'prj_idle_front' as ProjectId,
	tenantId: 'tnt_idle_front' as TenantId,
}

describe('agent front doors preserve the provider idle override', () => {
	let dirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(dirs)
		dirs = []
	})

	async function directory(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-idle-front-'))
		dirs.push(dir)
		return dir
	}

	async function withSafety<T>(caller: AbortController, operation: () => Promise<T>): Promise<T> {
		const timer = setTimeout(
			() => caller.abort(new Error('test safety bound: front door dropped idle timeout')),
			1_000,
		)
		try {
			return await operation()
		} finally {
			clearTimeout(timer)
		}
	}

	it('runAgent forwards it into the query run config', async () => {
		const provider = new NoRetryStallProvider()
		const caller = new AbortController()
		const workingDirectory = await directory()
		const result = await withSafety(caller, () =>
			runAgent({
				provider,
				model: 'mock-model',
				prompt: 'stall once',
				workingDirectory,
				streamIdleTimeoutMs: 10,
				signal: caller.signal,
				...scope,
			}),
		)

		expect(result.run.status).toBe('failed')
		expect(result.run.lastProviderError?.kind).toBe('network')
		expect(provider.calls).toBe(1)
		expect(caller.signal.aborted).toBe(false)
	})

	it('ReactiveAgent forwards it into the query run config', async () => {
		const provider = new NoRetryStallProvider()
		const caller = new AbortController()
		const workingDirectory = await directory()
		const agent = new ReactiveAgent({
			id: 'reactive-idle-front',
			name: 'Reactive Idle Front',
			version: '1',
			category: 'test',
			description: 'idle-bound reachability probe',
		})
		const config = {
			provider,
			tools: new ToolRegistry(),
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 5_000,
			streamIdleTimeoutMs: 10,
			maxIterations: 1,
			...scope,
		} satisfies ReactiveAgentConfig
		const result = await withSafety(caller, () =>
			agent.run(
				{
					messages: [createUserMessage('stall once')],
					workingDirectory,
					signal: caller.signal,
				},
				config,
			),
		)

		expect(result.status).toBe('failed')
		expect(provider.calls).toBe(1)
		expect(caller.signal.aborted).toBe(false)
	})

	it('SupervisorAgent forwards it into the query run config', async () => {
		const provider = new NoRetryStallProvider()
		const caller = new AbortController()
		const workingDirectory = await directory()
		const agent = new SupervisorAgent({
			id: 'supervisor-idle-front',
			name: 'Supervisor Idle Front',
			version: '1',
			category: 'test',
			description: 'idle-bound reachability probe',
		})
		const config = {
			provider,
			agentIds: [],
			allowDelegation: false,
			agentManager: { sendMessage: async () => ({}) } as never,
			systemPrompt: 'Answer directly.',
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 5_000,
			streamIdleTimeoutMs: 10,
			maxIterations: 1,
			...scope,
		} satisfies SupervisorAgentConfig
		const result = await withSafety(caller, () =>
			agent.run(
				{
					messages: [createUserMessage('stall once')],
					workingDirectory,
					signal: caller.signal,
				},
				config,
			),
		)

		expect(result.status).toBe('failed')
		expect(provider.calls).toBe(1)
		expect(caller.signal.aborted).toBe(false)
	})
})
