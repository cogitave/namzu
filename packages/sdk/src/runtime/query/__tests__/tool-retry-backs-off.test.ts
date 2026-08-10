/**
 * A retried tool call waits, and the wait is jittered.
 *
 * The in-loop retry was `for (let attempt = 1; ; attempt++)` calling straight
 * back into execution with no delay between attempts, while
 * `provider/retry.ts` one directory away implemented exponential backoff with
 * full jitter. The failures worth retrying are exactly the ones an immediate
 * retry makes worse — a rate limit, a contended lock, a connection that has
 * not finished opening — so the loop was most likely to prolong the condition
 * it was retrying against.
 *
 * Every delay here is measured on FAKE timers. A suite that spends real
 * seconds proving a wait gets deleted by the next person who reads its runtime,
 * and the assertions are exact rather than approximate for the same reason:
 * with the clock under control there is no measurement noise to leave slack
 * for, so a margin of one millisecond is a decision, not a coin toss.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ToolDefinition, ToolResult } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor, type ToolExecutorConfig } from '../executor.js'

const RUN_ID = 'run_backoff' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function response(name: string, args: string): ChatCompletionResponse {
	return {
		id: 'resp_1',
		model: 'mock',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }],
		},
		finishReason: 'tool_calls',
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	}
}

function makeExecutor(registry: ToolRegistry, extra: Partial<ToolExecutorConfig> = {}) {
	return new ToolExecutor(
		{
			tools: registry,
			runId: RUN_ID,
			workingDirectory: process.cwd(),
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			...extra,
		},
		new ActivityStore(RUN_ID, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		() => Promise.resolve(),
		makeLogger(),
	)
}

/** A tool that fails retryably `failures` times, then succeeds. */
function flakyTool(opts: { failures: number; maxRetries: number }) {
	const attempts: number[] = []
	const tool = {
		name: 'fetch_page',
		description: 'Fetch a page',
		inputSchema: z.object({ url: z.string() }),
		maxRetries: opts.maxRetries,
		execute: (): Promise<ToolResult> => {
			attempts.push(attempts.length + 1)
			if (attempts.length <= opts.failures) {
				return Promise.resolve({
					success: false,
					output: '',
					error: 'rate limited',
					retryable: true,
				})
			}
			return Promise.resolve({ success: true, output: `fetched on attempt ${attempts.length}` })
		},
	} as unknown as ToolDefinition
	return { tool, attempts }
}

const CALL = () => response('fetch_page', '{"url":"x"}')

/**
 * Run `body`, then always let the batch finish.
 *
 * The finally is the point. Every case below asserts part-way through a
 * pending `executeBatch`, so a mutation that makes the wait LONGER than the
 * case expects would leave that promise parked forever and the case would die
 * on the suite's timeout — and a timeout is a verdict on nothing at all, which
 * is exactly the outcome a mutation table must not fold into "killed". Winding
 * the clock right forward on the way out turns every such mutation into a
 * named assertion failure instead.
 */
async function draining<T>(pending: Promise<T>, body: () => Promise<void>): Promise<void> {
	try {
		await body()
	} finally {
		await vi.advanceTimersByTimeAsync(120_000)
		await pending
	}
}

let registry: ToolRegistry

beforeEach(() => {
	registry = new ToolRegistry()
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe('a retried tool call waits before trying again', () => {
	it('does not fire the second attempt until the backoff has elapsed', async () => {
		// Full jitter draws from `[0, curve]`, so pinning `Math.random` at 1
		// asks for the whole curve — the shipped `initialDelayMs` of 500.
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const { tool, attempts } = flakyTool({ failures: 1, maxRetries: 1 })
		registry.register(tool)

		const done = makeExecutor(registry).executeBatch(CALL())

		await draining(done, async () => {
			// The first attempt has run and failed. Nothing else may happen
			// while the clock has not moved past the wait — this is the
			// assertion the old loop, which re-entered immediately, could not
			// pass.
			await vi.advanceTimersByTimeAsync(499)
			expect(attempts).toHaveLength(1)

			await vi.advanceTimersByTimeAsync(1)
			expect(attempts).toHaveLength(2)
		})

		expect((await done).results[0]?.output).toBe('fetched on attempt 2')
	})

	it('draws the wait from the jitter rather than sleeping the curve exactly', async () => {
		// The property a fixed backoff does not have, and the reason it
		// matters here: `executeBatch` runs a whole batch of the model's
		// parallel calls at once, so a fixed wait would resynchronise a batch
		// that failed together against the endpoint that rate-limited it —
		// a thundering herd this loop assembles itself.
		vi.spyOn(Math, 'random').mockReturnValue(0.25)
		const { tool, attempts } = flakyTool({ failures: 1, maxRetries: 1 })
		registry.register(tool)

		const done = makeExecutor(registry, {
			toolRetryBackoff: { initialDelayMs: 1_000 },
		}).executeBatch(CALL())

		await draining(done, async () => {
			// A quarter of the 1s curve. An implementation that slept the
			// curve itself would still be waiting here.
			await vi.advanceTimersByTimeAsync(249)
			expect(attempts).toHaveLength(1)

			await vi.advanceTimersByTimeAsync(1)
			expect(attempts).toHaveLength(2)
		})
	})

	it('doubles the wait each attempt, up to the ceiling', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const { tool, attempts } = flakyTool({ failures: 2, maxRetries: 2 })
		registry.register(tool)

		const done = makeExecutor(registry, {
			toolRetryBackoff: { initialDelayMs: 1_000, maxDelayMs: 1_500 },
		}).executeBatch(CALL())

		await draining(done, async () => {
			await vi.advanceTimersByTimeAsync(1_000)
			expect(attempts).toHaveLength(2)

			// Doubling would ask for 2s; the ceiling holds it to 1.5s, so the
			// third attempt lands before an uncapped curve would allow it.
			await vi.advanceTimersByTimeAsync(1_499)
			expect(attempts).toHaveLength(2)

			await vi.advanceTimersByTimeAsync(1)
			expect(attempts).toHaveLength(3)
		})
	})

	it('never waits for a tool that did not opt into retrying', async () => {
		// The shipped default is zero retries, so an ordinary run must not
		// have acquired a delay it never had. Nothing here advances the
		// clock: if the executor slept, this call would not settle.
		const { tool, attempts } = flakyTool({ failures: 1, maxRetries: 0 })
		registry.register(tool)

		const batch = await makeExecutor(registry).executeBatch(CALL())

		expect(attempts).toHaveLength(1)
		expect(batch.results[0]?.isError).toBe(true)
	})

	it('stops retrying when the run is stopped mid-backoff, and still answers the call', async () => {
		// An abort thrown from inside the wait would escape `executeSingle`
		// and leave this `tool_use` unanswered in the transcript, which is
		// the one invariant the executor is not allowed to break. The failure
		// already in hand is a perfectly good answer to give.
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const controller = new AbortController()
		const { tool, attempts } = flakyTool({ failures: 1, maxRetries: 1 })
		registry.register(tool)

		const done = makeExecutor(registry, { abortSignal: controller.signal }).executeBatch(CALL())

		await vi.advanceTimersByTimeAsync(100)
		controller.abort()
		const batch = await done

		expect(attempts).toHaveLength(1)
		expect(batch.results).toHaveLength(1)
		expect(batch.results[0]?.toolCallId).toBe('call_1')
		expect(batch.results[0]?.isError).toBe(true)
		expect(batch.results[0]?.output).toContain('rate limited')
	})
})
