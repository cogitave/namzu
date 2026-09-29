import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
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
	sessionId: '52bdb4b0-b8f4-44c3-9e9e-acc5340904db' as SessionId,
	topicId: '309c39f1-d4c8-44e9-b7e1-fd47375e6e4b' as TopicId,
	projectId: '155a7982-54ec-43a1-a680-6ef2e18f0a2f' as ProjectId,
	tenantId: '84635f63-5785-42b8-8318-bf3e17a61c21' as TenantId,
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

	it('runAgent forwards it into the query run config', async () => {
		const provider = new NoRetryStallProvider()
		const caller = new AbortController()
		const workingDirectory = await directory()
		const result = await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'stall once',
			workingDirectory,
			streamIdleTimeoutMs: 10,
			signal: caller.signal,
			...scope,
		})

		// A stalled stream is a recoverable fault: the turn pauses to be resumed.
		expect(result.turn.stopReason).toBe('paused')
		expect(result.turn.lastProviderError?.kind).toBe('network')
		expect(provider.calls).toBe(1)
		expect(caller.signal.aborted).toBe(false)
	}, 30_000)

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
			toolsets: [],
			model: 'mock-model',
			tokenBudget: 100_000,
			// The idle override is the subject; the overall turn deadline must
			// not decide the result while setup is delayed on a shared runner.
			timeoutMs: 30_000,
			streamIdleTimeoutMs: 10,
			maxIterations: 1,
			...scope,
		} satisfies ReactiveAgentConfig
		const result = await agent.run(
			{
				messages: [createUserMessage('stall once')],
				workingDirectory,
				signal: caller.signal,
			},
			config,
		)

		expect(result.stopReason).toBe('paused')
		expect(provider.calls).toBe(1)
		expect(caller.signal.aborted).toBe(false)
	}, 30_000)

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
			// The provider idle override should win before the turn deadline.
			timeoutMs: 30_000,
			streamIdleTimeoutMs: 10,
			maxIterations: 1,
			...scope,
		} satisfies SupervisorAgentConfig
		const result = await agent.run(
			{
				messages: [createUserMessage('stall once')],
				workingDirectory,
				signal: caller.signal,
			},
			config,
		)

		expect(result.status).toBe('failed')
		expect(provider.calls).toBe(1)
		expect(caller.signal.aborted).toBe(false)
	}, 30_000)
})
