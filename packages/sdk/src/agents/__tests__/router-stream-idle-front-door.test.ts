import { describe, expect, it } from 'vitest'

import { EMPTY_TOKEN_USAGE, ZERO_COST } from '../../constants/limits.js'
import type {
	Agent,
	AgentCapabilities,
	AgentInput,
	AgentMetadata,
	BaseAgentConfig,
	BaseAgentResult,
} from '../../types/agent/index.js'
import type { RunId, TenantId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import type { RunEvent } from '../../types/run/index.js'
import { RouterAgent } from '../RouterAgent.js'

class AbortAwareRoutingStall implements LLMProvider {
	readonly id = 'routing-stall'
	readonly name = 'Routing Stall'
	readonly transportSignals: Array<AbortSignal | undefined> = []
	readonly started: Promise<void>
	private markStarted!: () => void

	constructor() {
		this.started = new Promise((resolve) => {
			this.markStarted = resolve
		})
	}

	chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const signal = params.signal
		this.transportSignals.push(signal)
		this.markStarted()

		return {
			[Symbol.asyncIterator]() {
				return {
					next: () =>
						new Promise<IteratorResult<StreamChunk>>((_resolve, reject) => {
							if (signal?.aborted) {
								reject(
									Object.assign(new Error('transport aborted'), {
										name: 'AbortError',
									}),
								)
								return
							}
							signal?.addEventListener(
								'abort',
								() =>
									reject(
										Object.assign(new Error('transport aborted'), {
											name: 'AbortError',
										}),
									),
								{ once: true },
							)
						}),
					return: async () => ({ done: true, value: undefined }),
				}
			},
		}
	}
}

const capabilities: AgentCapabilities = {
	supportsTools: false,
	supportsStreaming: false,
	supportsConcurrency: false,
	supportsSubAgents: false,
}

function recordingDelegate() {
	let calls = 0
	let receivedConfig: BaseAgentConfig | undefined
	const metadata: AgentMetadata = {
		type: 'reactive',
		id: 'fallback-worker',
		name: 'Fallback Worker',
		version: '1',
		category: 'test',
		description: 'records router delegation',
		capabilities,
	}
	const agent: Agent<BaseAgentConfig, BaseAgentResult> = {
		type: 'reactive',
		metadata,
		async run(input, config) {
			calls += 1
			receivedConfig = config
			return {
				runId: 'run_fallback_worker' as RunId,
				status: 'completed',
				stopReason: 'end_turn',
				usage: { ...EMPTY_TOKEN_USAGE },
				cost: { ...ZERO_COST },
				iterations: 1,
				durationMs: 1,
				messages: input.messages,
				result: 'fallback delegate answered',
			}
		},
		async cancel() {},
		getCapabilities: () => capabilities,
	}
	return {
		agent,
		calls: () => calls,
		receivedConfig: () => receivedConfig,
	}
}

function routerInput(signal: AbortSignal): AgentInput {
	return {
		messages: [createUserMessage('route this request')],
		workingDirectory: process.cwd(),
		signal,
	}
}

function routerConfig(
	provider: LLMProvider,
	delegate: Agent<BaseAgentConfig, BaseAgentResult>,
	streamIdleTimeoutMs: number,
) {
	return {
		provider,
		model: 'routing-model',
		tokenBudget: 10_000,
		timeoutMs: 5_000,
		streamIdleTimeoutMs,
		maxRoutingRetries: 1,
		fallbackAgentId: 'fallback-worker',
		routes: [
			{
				agentId: 'fallback-worker',
				agent: delegate,
				description: 'fallback route',
			},
		],
		invocationState: { tenantId: 'tnt_router_idle' as TenantId },
	}
}

async function withinSafety<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error('test safety bound: RouterAgent routing call did not settle')),
					1_000,
				)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

describe('RouterAgent owns the liveness of its routing model call', () => {
	it('aborts a stalled routing transport and delegates through its declared fallback', async () => {
		const provider = new AbortAwareRoutingStall()
		const delegate = recordingDelegate()
		const caller = new AbortController()
		const router = new RouterAgent({
			id: 'idle-router',
			name: 'Idle Router',
			version: '1',
			category: 'test',
			description: 'routes after a bounded model decision',
		})
		try {
			const result = await withinSafety(
				router.run(routerInput(caller.signal), routerConfig(provider, delegate.agent, 10)),
			)

			expect(result.status).toBe('completed')
			expect(result.result).toBe('fallback delegate answered')
			expect(result.selectedRoute).toBe('fallback-worker')
			expect(result.routingDecision.routingSource).toBe('fallback')
			expect(delegate.calls()).toBe(1)
			expect(delegate.receivedConfig()?.invocationState?.parentChain).toEqual(['idle-router'])
			expect(provider.transportSignals).toHaveLength(1)
			expect(provider.transportSignals[0]).not.toBe(caller.signal)
			expect(provider.transportSignals[0]?.aborted).toBe(true)
			expect(provider.transportSignals[0]?.reason).toMatchObject({
				name: 'ProviderRequestError',
				kind: 'network',
			})
			expect(caller.signal.aborted).toBe(false)
		} finally {
			if (!caller.signal.aborted) caller.abort(new Error('test cleanup'))
		}
	})

	it('does not reinterpret caller cancellation as permission to delegate', async () => {
		const provider = new AbortAwareRoutingStall()
		const delegate = recordingDelegate()
		const caller = new AbortController()
		const reason = new Error('operator stopped routing')
		const router = new RouterAgent({
			id: 'cancelled-router',
			name: 'Cancelled Router',
			version: '1',
			category: 'test',
			description: 'does not delegate after cancellation',
		})
		const running = router.run(
			routerInput(caller.signal),
			routerConfig(provider, delegate.agent, 30_000),
		)
		await provider.started

		caller.abort(reason)

		await expect(withinSafety(running)).rejects.toBe(reason)
		expect(delegate.calls()).toBe(0)
		expect(provider.transportSignals[0]?.aborted).toBe(true)
	})

	it('lets agent cancellation close the routing transport without starting a delegate', async () => {
		const provider = new AbortAwareRoutingStall()
		const delegate = recordingDelegate()
		const caller = new AbortController()
		const router = new RouterAgent({
			id: 'stopped-router',
			name: 'Stopped Router',
			version: '1',
			category: 'test',
			description: 'propagates its own cancellation into routing',
		})
		const running = router.run(
			routerInput(caller.signal),
			routerConfig(provider, delegate.agent, 30_000),
		)
		await provider.started

		await router.cancel('user')

		await expect(withinSafety(running)).rejects.toMatchObject({
			name: 'RunCancelled',
			cancelCause: 'user',
		})
		expect(delegate.calls()).toBe(0)
		expect(provider.transportSignals[0]?.aborted).toBe(true)
		expect(caller.signal.aborted).toBe(false)
	})

	it('refuses a malformed bound before creating a run or calling either agent', async () => {
		const provider = new AbortAwareRoutingStall()
		const delegate = recordingDelegate()
		const caller = new AbortController()
		const events: RunEvent[] = []
		const router = new RouterAgent({
			id: 'invalid-router',
			name: 'Invalid Router',
			version: '1',
			category: 'test',
			description: 'refuses invalid stream bounds',
		})

		await expect(
			router.run(
				routerInput(caller.signal),
				routerConfig(provider, delegate.agent, Number.NaN),
				(event) => {
					events.push(event)
				},
			),
		).rejects.toThrow(/streamIdleTimeoutMs must be an integer/)
		expect(events).toEqual([])
		expect(provider.transportSignals).toEqual([])
		expect(delegate.calls()).toBe(0)
	})
})
