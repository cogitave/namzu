import { describe, expect, it } from 'vitest'

import { ToolRegistry } from '../../registry/index.js'
import type { AgentInput } from '../../types/agent/base.js'
import type { ReactiveAgentConfig } from '../../types/agent/reactive.js'
import { ReactiveAgent } from '../ReactiveAgent.js'

/**
 * A caller sends a request, the connection drops, the caller retries.
 * Without a key the retry is a second full run — a second set of model
 * calls, and a second set of whatever the tools did. The invocation lock
 * alone does not help: refusing the retry with an error is not what the
 * caller wanted either. They wanted the answer.
 */

/**
 * A provider that blocks until released, so two invocations can overlap.
 *
 * The gate is created UP FRONT rather than assigned inside the generator:
 * a generator body does not run until its consumer pulls, so a test that
 * released immediately after calling `run` would be resolving a promise
 * that did not exist yet and would hang.
 */
function blockingProvider() {
	let open: (() => void) | undefined
	let gate = new Promise<void>((resolve) => {
		open = resolve
	})
	let calls = 0

	const provider = {
		id: 'test',
		name: 'Test',
		capabilities: {},
		async *chatStream() {
			calls++
			await gate
			yield { id: 'c', delta: { content: 'ok' }, finishReason: 'stop' }
		},
	}

	return {
		provider,
		calls: () => calls,
		release: () => open?.(),
		/** Re-close it, so a second invocation can be held the same way. */
		reset: () => {
			gate = new Promise<void>((resolve) => {
				open = resolve
			})
		},
	}
}

function failingProvider() {
	let calls = 0
	return {
		calls: () => calls,
		provider: {
			id: 'test',
			name: 'Test',
			capabilities: {},
			// biome-ignore lint/correctness/useYield: it fails before producing anything
			async *chatStream() {
				calls++
				await new Promise((resolve) => setTimeout(resolve, 5))
				throw new Error('the provider is down')
			},
		},
	}
}

const config = (provider: unknown, idempotencyKey?: string): ReactiveAgentConfig =>
	({
		provider,
		tools: new ToolRegistry(),
		model: 'm',
		tokenBudget: 1_000,
		timeoutMs: 10_000,
		sessionId: 'ses_1',
		topicId: 'thr_1',
		projectId: 'prj_1',
		tenantId: 'ten_1',
		...(idempotencyKey ? { idempotencyKey } : {}),
	}) as unknown as ReactiveAgentConfig

const input: AgentInput = { messages: [{ role: 'user', content: 'go' }] } as AgentInput

const agent = () =>
	new ReactiveAgent({
		id: 'a',
		name: 'A',
		type: 'reactive',
		capabilities: {},
	} as never)

describe('a retried invocation carrying the same key', () => {
	it('joins the one already running instead of starting a second', async () => {
		const { provider, calls, release } = blockingProvider()
		const a = agent()

		const first = a.run(input, config(provider, 'req_1'))
		const retry = a.run(input, config(provider, 'req_1'))
		release()
		const [one, two] = await Promise.all([first, retry])

		// One model call, and both callers hold the same answer — not an
		// error telling the second one to go away.
		expect(calls()).toBe(1)
		expect(two.runId).toBe(one.runId)
	})

	it('shares the failure too', async () => {
		// Both callers asked the same question once. Telling one of them
		// something different would make the key a lie.
		const { provider, calls } = failingProvider()
		const a = agent()

		const first = a.run(input, config(provider, 'req_1'))
		const retry = a.run(input, config(provider, 'req_1'))
		const [one, two] = await Promise.all([first, retry].map((p) => p.catch((e) => e)))

		expect(calls()).toBe(1)
		expect(two).toBe(one)
	})

	it('runs again once the first has settled', async () => {
		// In-flight only. Keeping the answer would turn deduplication into
		// caching, and staleness is the host's judgement, not the SDK's.
		const { provider, calls, release, reset } = blockingProvider()
		const a = agent()

		const first = a.run(input, config(provider, 'req_1'))
		release()
		await first

		reset()
		const second = a.run(input, config(provider, 'req_1'))
		release()
		await second

		expect(calls()).toBe(2)
	})
})

describe('an invocation without a key', () => {
	it('is refused while another is running, as before', async () => {
		// The lock still owns the no-key case: two overlapping runs share one
		// abort controller and one run id, and neither failure announces
		// itself.
		const { provider, release } = blockingProvider()
		const a = agent()

		const first = a.run(input, config(provider))
		const overlapping = a.run(input, config(provider)).catch((err: Error) => err)
		release()

		await first
		expect(await overlapping).toBeInstanceOf(Error)
	})

	it('does not join an invocation carrying a different key', async () => {
		const { provider, calls, release } = blockingProvider()
		const a = agent()

		const first = a.run(input, config(provider, 'req_1'))
		const other = a.run(input, config(provider, 'req_2')).catch((err: Error) => err)
		release()
		await first
		await other

		// A different key is a different request; it must not be answered
		// with this one's result.
		expect(calls()).toBe(1)
		expect(await other).toBeInstanceOf(Error)
	})
})
