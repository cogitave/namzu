import { describe, expect, it, vi } from 'vitest'

import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { DEFAULT_TOOL_TIMEOUT_MS, ToolExecutor } from '../executor.js'

/**
 * `ToolContext.abortSignal` was produced by the executor and consumed by
 * nothing — a repo-wide grep found only the two producer sites. A Stop tore
 * down the model stream and then parked inside `Promise.all` waiting on a
 * tool that had no idea it should quit, and no framework-level deadline
 * existed at all: `bash` defaulted to one hour, MCP stdio to forever.
 */

const RUN_ID = 'run_timeout' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function response(...names: string[]): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: names.map((name, i) => ({
				id: `call_${i}`,
				type: 'function' as const,
				function: { name, arguments: '{}' },
			})),
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

interface Harness {
	exec: ToolExecutor
	/** Signals handed to each tool invocation, in call order. */
	signals: AbortSignal[]
	peakConcurrency: () => number
}

function harness(opts: {
	run: (name: string, signal: AbortSignal) => Promise<{ success: boolean; output: string }>
	toolTimeoutMs?: number
	perToolTimeoutMs?: Record<string, number>
	maxToolConcurrency?: number
	abortSignal?: AbortSignal
	concurrencySafe?: boolean
}): Harness {
	const signals: AbortSignal[] = []
	let inFlight = 0
	let peak = 0

	const tools = {
		get: vi.fn((name: string) => ({
			name,
			isConcurrencySafe: () => opts.concurrencySafe ?? true,
			isReadOnly: () => true,
			isDestructive: () => false,
			...(opts.perToolTimeoutMs?.[name] !== undefined
				? { timeoutMs: opts.perToolTimeoutMs[name] }
				: {}),
		})),
		execute: vi.fn(async (name: string, _input: unknown, ctx: { abortSignal: AbortSignal }) => {
			signals.push(ctx.abortSignal)
			inFlight++
			peak = Math.max(peak, inFlight)
			try {
				return await opts.run(name, ctx.abortSignal)
			} finally {
				inFlight--
			}
		}),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
		getAvailability: vi.fn(() => 'active'),
		register: vi.fn(),
		unregister: vi.fn(),
	} as unknown as ToolRegistryContract

	const exec = new ToolExecutor(
		{
			tools,
			runId: RUN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: opts.abortSignal ?? new AbortController().signal,
			...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
			...(opts.maxToolConcurrency !== undefined
				? { maxToolConcurrency: opts.maxToolConcurrency }
				: {}),
		},
		new ActivityStore(RUN_ID, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
		async () => {},
		makeLogger(),
	)

	return { exec, signals, peakConcurrency: () => peak }
}

const never = () => new Promise<never>(() => {})

describe('ToolExecutor — per-tool deadline', () => {
	it('abandons a hung tool and reports the timeout as a tool_result', async () => {
		const h = harness({ toolTimeoutMs: 20, run: never })
		const batch = await h.exec.executeBatch(response('hang'))

		expect(batch.results).toHaveLength(1)
		expect(batch.results[0]?.output).toContain('timed out after 20ms')
		// It is still an ANSWER — the assistant turn stays complete.
		expect(batch.messages[0]?.role).toBe('tool')
	})

	it('fires the tool context abort signal on timeout so a cooperative tool stops', async () => {
		let observed = false
		const h = harness({
			toolTimeoutMs: 20,
			run: (_name, signal) =>
				new Promise((_resolve) => {
					signal.addEventListener('abort', () => {
						observed = true
					})
				}),
		})
		await h.exec.executeBatch(response('hang'))
		expect(observed).toBe(true)
	})

	it('a per-tool timeoutMs overrides the run default', async () => {
		const h = harness({
			toolTimeoutMs: 5_000,
			perToolTimeoutMs: { quick: 20 },
			run: never,
		})
		const batch = await h.exec.executeBatch(response('quick'))
		expect(batch.results[0]?.output).toContain('timed out after 20ms')
	})

	it('does not disturb a tool that finishes in time', async () => {
		const h = harness({
			toolTimeoutMs: 5_000,
			run: async () => ({ success: true, output: 'done' }),
		})
		const batch = await h.exec.executeBatch(response('fast'))
		expect(batch.results[0]?.output).toBe('done')
		expect(h.signals[0]?.aborted).toBe(false)
	})

	it('cancels an in-flight tool when the RUN is aborted', async () => {
		const controller = new AbortController()
		const h = harness({
			toolTimeoutMs: 60_000,
			abortSignal: controller.signal,
			run: never,
		})
		const pending = h.exec.executeBatch(response('hang'))
		controller.abort()
		const batch = await pending

		expect(batch.results[0]?.output).toContain('was cancelled')
	})

	it('propagates an already-aborted run signal immediately', async () => {
		const controller = new AbortController()
		controller.abort()
		const h = harness({ abortSignal: controller.signal, run: never })
		const batch = await h.exec.executeBatch(response('hang'))
		expect(batch.results[0]?.output).toContain('was cancelled')
	})

	it('exposes a sane default deadline', () => {
		// Documented so a change is a deliberate decision, not a drift.
		expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(120_000)
	})
})

describe('ToolExecutor — bounded fan-out', () => {
	it('caps concurrently-running concurrency-safe tools', async () => {
		let release: (() => void) | undefined
		const gateOpen = new Promise<void>((r) => {
			release = r
		})
		let started = 0

		const h = harness({
			maxToolConcurrency: 2,
			toolTimeoutMs: 5_000,
			run: async () => {
				started++
				await gateOpen
				return { success: true, output: 'ok' }
			},
		})

		const pending = h.exec.executeBatch(response('a', 'b', 'c', 'd', 'e'))
		// Let the first wave schedule.
		await new Promise((r) => setTimeout(r, 5))
		expect(started).toBe(2)

		release?.()
		await pending
		expect(h.peakConcurrency()).toBeLessThanOrEqual(2)
	})

	it('still answers every call when the batch exceeds the cap', async () => {
		const h = harness({
			maxToolConcurrency: 2,
			run: async () => ({ success: true, output: 'ok' }),
		})
		const batch = await h.exec.executeBatch(response('a', 'b', 'c', 'd', 'e'))
		expect(batch.messages).toHaveLength(5)
		// Order must still match the tool_use order.
		expect(batch.results.map((r) => r.toolCallId)).toEqual([
			'call_0',
			'call_1',
			'call_2',
			'call_3',
			'call_4',
		])
	})
})
