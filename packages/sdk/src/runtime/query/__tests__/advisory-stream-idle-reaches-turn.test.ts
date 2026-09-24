import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

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
import { TurnCancelled } from '../../../types/session/cancel-cause.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { drainQuery } from '../index.js'

class AbortAwareAdvisorProvider implements LLMProvider {
	readonly id = 'stalled-advisor'
	readonly name = 'Stalled advisor'
	readonly transportSignals: AbortSignal[] = []
	readonly started: Promise<void>
	private markStarted!: () => void

	constructor() {
		this.started = new Promise((resolve) => {
			this.markStarted = resolve
		})
	}

	chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const signal = params.signal
		if (!signal) throw new Error('query did not give the advisor a transport signal')
		this.transportSignals.push(signal)
		const markStarted = this.markStarted

		return {
			[Symbol.asyncIterator]() {
				return {
					next: () =>
						new Promise<IteratorResult<StreamChunk>>((_resolve, reject) => {
							const onAbort = () => reject(signal.reason)
							if (signal.aborted) onAbort()
							else signal.addEventListener('abort', onAbort, { once: true })
							markStarted()
						}),
					return: async () => ({ done: true, value: undefined }),
				}
			},
		}
	}
}

function tools(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register({
		name: 'echo',
		description: 'Return the supplied text.',
		inputSchema: z.object({ text: z.string() }),
		execute: async ({ text }) => ({ success: true, output: text }),
	})
	return registry
}

function params(
	main: LLMProvider,
	advisor: LLMProvider,
	workingDirectory: string,
	caller: AbortController,
	idleTimeoutMs: number,
) {
	return {
		provider: main,
		tools: tools(),
		turnConfig: {
			model: 'main-model',
			timeoutMs: 5_000,
			streamIdleTimeoutMs: idleTimeoutMs,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
		},
		advisory: {
			advisors: [
				{
					id: 'reviewer',
					name: 'Reviewer',
					provider: advisor,
					model: 'advisor-model',
				},
			],
			triggers: [
				{
					id: 'every-turn',
					condition: { type: 'on_iteration' as const, everyN: 1 },
					advisorId: 'reviewer',
				},
			],
		},
		agentId: 'agent_advisory_idle',
		agentName: 'Advisory Idle Agent',
		messages: [createUserMessage('Use echo, then answer.')],
		workingDirectory,
		sessionId: '16900fe9-bf9e-47eb-8167-967096530768' as SessionId,
		topicId: '05fe2d41-f83c-4567-8c39-07b731dd5de1' as TopicId,
		projectId: 'de774a69-52b1-4fb6-83aa-e31ae81c20f8' as ProjectId,
		tenantId: '7f83f81b-6af5-410f-917c-af1dc0532b83' as TenantId,
		signal: caller.signal,
		retry: false as const,
	}
}

describe('query-owned advisors inherit the turn stream boundary', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	async function workdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-advisory-idle-'))
		workdirs.push(dir)
		return dir
	}

	it('aborts a stalled advisor privately and stops further spend while its usage is unresolved', async () => {
		const main = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ name: 'echo', args: { text: 'ready' } }] },
				{ text: 'main run completed' },
			],
		})
		const advisor = new AbortAwareAdvisorProvider()
		const caller = new AbortController()
		const events: SessionEvent[] = []
		const dir = await workdir()

		// The advisor's stall watchdog (`streamIdleTimeoutMs: 10`) is a real
		// `setTimeout` inside `withStreamIdleTimeout`, and this case used to
		// race it against a one-second real-time safety bound instead of
		// controlling it. Both sides read the wall clock, so a loaded CI
		// runner — several forked test files competing for the same CPU —
		// could make the "private abort, then finish on the table" path take
		// longer in real time than the hand-rolled safety net, which then
		// aborted the caller itself and turned `run.status` into `cancelled`.
		// Reproduced locally by pinning the process to one starved core
		// (`taskset -c 0`, a dozen busy loops on the same core): the run
		// consistently came back `cancelled`.
		//
		// A fake clock removes the race rather than widening it: the watchdog
		// fires on exactly one deterministic advance, timed to the real event
		// (`advisor.started`) that marks the request as open, so nothing here
		// depends on how fast the host machine is. If a regression left the
		// advisor's abort unresolved, `await running` would hang and fail on
		// Vitest's own test timeout — a real bug, not a clock coincidence.
		vi.useFakeTimers()
		try {
			const running = drainQuery(params(main, advisor, dir, caller, 10), (event) => {
				events.push(event)
			})

			await advisor.started
			await vi.advanceTimersByTimeAsync(10)

			const run = await running

			expect(run.status).toBe('completed')
			expect(run.stopReason).toBe('token_budget')
			expect(run.budget).toMatchObject({ poisoned: true, inFlightRequests: 1, remainingTokens: 0 })
			expect(main.requests).toHaveLength(1)
			expect(advisor.transportSignals).toHaveLength(1)
			expect(advisor.transportSignals[0]?.aborted).toBe(true)
			expect(advisor.transportSignals[0]?.reason).toMatchObject({
				name: 'ProviderRequestError',
				kind: 'network',
				providerId: advisor.id,
			})
			expect(events.some((event) => event.type === 'turn_failed')).toBe(false)
			expect([...events].reverse().find((event) => event.type === 'turn_completed')).toMatchObject({
				type: 'turn_completed',
				stopReason: 'token_budget',
			})
			expect(caller.signal.aborted).toBe(false)
		} finally {
			vi.useRealTimers()
			if (!caller.signal.aborted) caller.abort(new Error('test cleanup'))
		}
	})

	it('closes a pending advisor with the turn cancellation cause', async () => {
		const main = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'echo', args: { text: 'ready' } }] }],
		})
		const advisor = new AbortAwareAdvisorProvider()
		const caller = new AbortController()
		const events: SessionEvent[] = []
		const dir = await workdir()

		// streamIdleTimeoutMs is 0 here — the watchdog is disabled for this
		// case — so unlike the case above there is no internal timer to
		// advance: both waits below settle purely on real microtask and
		// abort-listener scheduling. The previous version guarded each one
		// with its own real setTimeout (500ms, then 200ms) racing that
		// scheduling, which is the same pattern that made the case above
		// flaky under CI load: a starved event loop can legitimately take
		// longer than either bound without anything being broken. Reproduced
		// locally under the same starved-core load used for that fix, this
		// case failed with "advisor request did not start" well before the
		// advisor's request had actually failed to start.
		//
		// Fake timers remove the race rather than widen it: fake time never
		// advances on its own, so nothing here can time out from CPU
		// contention. A genuine hang — the advisor never opening its
		// request, or the run ignoring cancellation — still fails the test,
		// on Vitest's own real per-test timeout, which is a correctness
		// signal rather than a clock coincidence.
		vi.useFakeTimers()
		try {
			const running = drainQuery(params(main, advisor, dir, caller, 0), (event) => {
				events.push(event)
			})

			await advisor.started
			const stop = new Error('operator stopped the advisory run')
			caller.abort(stop)

			const run = await running

			expect(run.status).toBe('cancelled')
			expect(run.stopReason).toBe('cancelled')
			expect(advisor.transportSignals).toHaveLength(1)
			expect(advisor.transportSignals[0]?.aborted).toBe(true)
			expect(advisor.transportSignals[0]?.reason).toBe(stop)
			expect([...events].reverse().find((event) => event.type === 'turn_completed')).toMatchObject({
				type: 'turn_completed',
				stopReason: 'cancelled',
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it('starts no main or advisory model call when the caller already cancelled', async () => {
		const main = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const advisor = new AbortAwareAdvisorProvider()
		const caller = new AbortController()
		const stop = new TurnCancelled('user')
		caller.abort(stop)
		const events: SessionEvent[] = []

		const run = await drainQuery(params(main, advisor, await workdir(), caller, 10), (event) => {
			events.push(event)
		})

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(main.requests).toHaveLength(0)
		expect(advisor.transportSignals).toHaveLength(0)
		expect([...events].reverse().find((event) => event.type === 'turn_completed')).toMatchObject({
			type: 'turn_completed',
			stopReason: 'cancelled',
			cancelCause: 'user',
		})
	})
})
