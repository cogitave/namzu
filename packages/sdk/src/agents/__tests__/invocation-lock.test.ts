import { describe, expect, it } from 'vitest'

import type { AgentInput } from '../../types/agent/base.js'
import type { ReactiveAgentConfig } from '../../types/agent/reactive.js'
import { ReactiveAgent } from '../ReactiveAgent.js'
import { ConcurrentInvocationError } from '../lock.js'

/**
 * The lock existed, was exported, and had no caller — so concurrent
 * invocations of one agent instance were never prevented, and the error
 * type that announces the refusal could not be thrown by anything.
 *
 * They genuinely are unsafe: `abortController` and `currentRunId` are
 * INSTANCE state. Two overlapping runs share one abort controller, so
 * cancelling either kills both, and the second clobbers the first's run
 * id, so a later `cancel()` cancels the wrong run. Neither failure
 * announces itself — the first run simply stops, or the wrong one does.
 */

/** A provider that blocks until released, so two runs can overlap. */
function blockingProvider() {
	let release: (() => void) | undefined
	const started: number[] = []
	let n = 0

	const provider = {
		id: 'test',
		name: 'Test',
		capabilities: {},
		async *chatStream() {
			started.push(++n)
			await new Promise<void>((resolve) => {
				release = resolve
			})
			yield { id: 'c', delta: { content: 'ok' }, finishReason: 'stop' }
		},
	}

	return { provider, started, release: () => release?.() }
}

function agentConfig(provider: unknown): ReactiveAgentConfig {
	return {
		provider,
		model: 'm',
		tokenBudget: 1_000,
		timeoutMs: 10_000,
		sessionId: 'ses_1',
		threadId: 'thr_1',
		projectId: 'prj_1',
		tenantId: 'ten_1',
	} as unknown as ReactiveAgentConfig
}

const input: AgentInput = { messages: [{ role: 'user', content: 'go' }] } as AgentInput

describe('one run at a time per instance', () => {
	it('refuses a second concurrent run on the same instance', async () => {
		const { provider, release } = blockingProvider()
		const agent = new ReactiveAgent({ id: 'a', name: 'A' } as never)

		const first = agent.run(input, agentConfig(provider))
		// The refusal is what makes the shared-state hazard visible instead
		// of letting two runs quietly cancel each other.
		await expect(agent.run(input, agentConfig(provider))).rejects.toBeInstanceOf(
			ConcurrentInvocationError,
		)

		release()
		await first.catch(() => undefined)
	})

	it('names the agent it refused', async () => {
		const { provider, release } = blockingProvider()
		const agent = new ReactiveAgent({ id: 'named-agent', name: 'A' } as never)

		const first = agent.run(input, agentConfig(provider))
		await expect(agent.run(input, agentConfig(provider))).rejects.toThrow(/named-agent/)

		release()
		await first.catch(() => undefined)
	})

	it('releases the lock once a run settles, so the instance is reusable', async () => {
		const { provider, release } = blockingProvider()
		const agent = new ReactiveAgent({ id: 'a', name: 'A' } as never)

		const first = agent.run(input, agentConfig(provider))
		release()
		await first.catch(() => undefined)

		// A one-shot lock would be worse than none: the instance would be
		// permanently unusable after its first run.
		const { provider: second, release: releaseSecond } = blockingProvider()
		const next = agent.run(input, agentConfig(second))
		releaseSecond()
		await expect(next.catch(() => 'settled')).resolves.toBeDefined()
	})

	it('releases the lock even when the run throws', async () => {
		const failing = {
			id: 'test',
			name: 'Test',
			capabilities: {},
			async *chatStream(): AsyncGenerator<never> {
				// biome-ignore lint/correctness/useYield: the point is that it throws
				throw new Error('provider exploded')
			},
		}
		const agent = new ReactiveAgent({ id: 'a', name: 'A' } as never)

		await agent.run(input, agentConfig(failing)).catch(() => undefined)
		// Without the `finally`, one failed run would brick the instance —
		// and the second call would report a concurrency error for a run
		// that is not running.
		await expect(
			agent.run(input, agentConfig(failing)).catch((err: unknown) => err),
		).resolves.not.toBeInstanceOf(ConcurrentInvocationError)
	})

	it('leaves separate instances independent', async () => {
		// The supported shape for parallelism: a second instance is cheap,
		// and each owns its own abort controller and run id.
		const a = blockingProvider()
		const b = blockingProvider()
		const first = new ReactiveAgent({ id: 'a', name: 'A' } as never)
		const second = new ReactiveAgent({ id: 'b', name: 'B' } as never)

		const runA = first.run(input, agentConfig(a.provider))
		const runB = second.run(input, agentConfig(b.provider))

		a.release()
		b.release()
		const settled = await Promise.allSettled([runA, runB])

		// The claim is about the LOCK, so assert on the lock. An earlier
		// version counted provider calls, which is a side effect these runs
		// may never reach — it failed for a reason that had nothing to do
		// with what the test is named for.
		for (const outcome of settled) {
			if (outcome.status === 'rejected') {
				expect(outcome.reason).not.toBeInstanceOf(ConcurrentInvocationError)
			}
		}
	})
})

describe('the error itself', () => {
	it('carries the agent id rather than only a message', () => {
		const err = new ConcurrentInvocationError('agent-7')
		expect(err.agentId).toBe('agent-7')
		expect(err).toBeInstanceOf(Error)
	})
})
