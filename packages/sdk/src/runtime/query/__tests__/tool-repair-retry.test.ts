import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ToolDefinition, ToolResult } from '../../../types/tool/index.js'
import type { RepairToolCall } from '../../../types/tool/repair.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor, type ToolExecutorConfig } from '../executor.js'

/**
 * Two failure modes that both used to cost a full model round trip.
 *
 * A malformed tool call went back as a `tool_result` error; the model
 * re-read the entire context and issued a second inference to add a
 * missing brace. A transient tool failure did the same, except the model
 * also had to decide on its own that retrying was worth it.
 */

const RUN_ID = 'run_repair' as RunId

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

function makeExecutor(
	registry: ToolRegistry,
	extra: Partial<ToolExecutorConfig> = {},
): { executor: ToolExecutor } {
	const executor = new ToolExecutor(
		{
			tools: registry,
			runId: RUN_ID,
			workingDirectory: process.cwd(),
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			// These cases are about WHICH failures are retried and how many
			// times, not about the wait between attempts — and the wait is
			// real. `tool-retry-backs-off.test.ts` owns the delay, on fake
			// timers; leaving the default on here would spend seconds of the
			// suite's runtime re-proving it slowly.
			toolRetryBackoff: { initialDelayMs: 0, maxDelayMs: 0 },
			...extra,
		},
		new ActivityStore(RUN_ID, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		() => Promise.resolve(),
		makeLogger(),
	)
	return { executor }
}

/** A tool that fails `failures` times, then succeeds. */
function flakyTool(opts: { failures: number; retryable: boolean; maxRetries?: number }) {
	const attempts: number[] = []
	let seen = 0
	const tool = {
		name: 'fetch_page',
		description: 'Fetch a page',
		inputSchema: z.object({ url: z.string() }),
		...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
		execute: (): Promise<ToolResult> => {
			seen++
			attempts.push(seen)
			if (seen <= opts.failures) {
				return Promise.resolve({
					success: false,
					output: '',
					error: 'connection reset',
					retryable: opts.retryable,
				})
			}
			return Promise.resolve({ success: true, output: `fetched on attempt ${seen}` })
		},
	} as unknown as ToolDefinition
	return { tool, attempts }
}

let registry: ToolRegistry

beforeEach(() => {
	registry = new ToolRegistry()
})

describe('repairToolCall', () => {
	const readFile = {
		name: 'read_file',
		description: 'Read a file',
		inputSchema: z.object({ path: z.string() }),
		execute: (input: unknown) =>
			Promise.resolve({ success: true, output: `read ${(input as { path: string }).path}` }),
	} as unknown as ToolDefinition

	beforeEach(() => {
		registry.register(readFile)
	})

	it('fixes unparseable arguments instead of spending a round trip on it', async () => {
		const repair: RepairToolCall = ({ reason }) =>
			reason === 'invalid_json' ? { arguments: '{"path":"a.ts"}' } : null

		const { executor } = makeExecutor(registry, { repairToolCall: repair })
		const batch = await executor.executeBatch(response('read_file', '{"path": "a.ts'))

		expect(batch.results[0]?.isError).toBeFalsy()
		expect(batch.results[0]?.output).toBe('read a.ts')
	})

	it('hands the repairer the schema to aim at', async () => {
		const seen = vi.fn<RepairToolCall>(() => null)
		const { executor } = makeExecutor(registry, { repairToolCall: seen })
		await executor.executeBatch(response('read_file', '{bad'))

		expect(seen).toHaveBeenCalledOnce()
		const ctx = seen.mock.calls[0]?.[0]
		expect(ctx?.reason).toBe('invalid_json')
		expect(ctx?.jsonSchema).toMatchObject({ properties: { path: { type: 'string' } } })
		expect(ctx?.availableTools).toContain('read_file')
	})

	it('can correct a near-miss tool name', async () => {
		const repair: RepairToolCall = ({ reason, availableTools }) =>
			reason === 'unknown_tool'
				? { toolName: availableTools[0] as string, arguments: '{"path":"b.ts"}' }
				: null

		const { executor } = makeExecutor(registry, { repairToolCall: repair })
		const batch = await executor.executeBatch(response('readFile', '{"path":"b.ts"}'))

		expect(batch.results[0]?.output).toBe('read b.ts')
		expect(batch.results[0]?.toolName).toBe('read_file')
	})

	it('repairs arguments that parse but violate the schema', async () => {
		const repair: RepairToolCall = ({ reason }) =>
			reason === 'schema_validation' ? { arguments: '{"path":"c.ts"}' } : null

		const { executor } = makeExecutor(registry, { repairToolCall: repair })
		const batch = await executor.executeBatch(response('read_file', '{"path": 42}'))

		expect(batch.results[0]?.output).toBe('read c.ts')
	})

	it('declining is normal — the original error proceeds unchanged', async () => {
		const { executor } = makeExecutor(registry, { repairToolCall: () => null })
		const batch = await executor.executeBatch(response('read_file', '{bad'))

		expect(batch.results[0]?.isError).toBe(true)
		expect(batch.results[0]?.output).toContain('Invalid JSON')
	})

	it('tries exactly once — a still-broken repair does not loop', async () => {
		// An unbounded repair loop is a hang, not a degradation.
		const repair = vi.fn<RepairToolCall>(() => ({ arguments: 'still not json' }))
		const { executor } = makeExecutor(registry, { repairToolCall: repair })
		const batch = await executor.executeBatch(response('read_file', '{bad'))

		expect(repair).toHaveBeenCalledOnce()
		expect(batch.results[0]?.isError).toBe(true)
	})

	it('a throwing repairer does not take the run down', async () => {
		const { executor } = makeExecutor(registry, {
			repairToolCall: () => {
				throw new Error('repair model unavailable')
			},
		})
		const batch = await executor.executeBatch(response('read_file', '{bad'))

		// The original error was always a perfectly good answer to give.
		expect(batch.results[0]?.output).toContain('Invalid JSON')
	})

	it('with no repairer configured, behavior is exactly as before', async () => {
		const { executor } = makeExecutor(registry)
		const ok = await executor.executeBatch(response('read_file', '{"path":"d.ts"}'))
		expect(ok.results[0]?.output).toBe('read d.ts')

		const bad = await executor.executeBatch(response('read_file', '{bad'))
		expect(bad.results[0]?.output).toContain('Invalid JSON')

		// Schema errors still come from the registry, which has the better
		// message — a "Required: ..." hint the model can self-correct from.
		const invalid = await executor.executeBatch(response('read_file', '{"path": 42}'))
		expect(invalid.results[0]?.isError).toBe(true)
	})
})

describe('per-tool retry budget', () => {
	it('retries a retryable failure in-loop and reports the success', async () => {
		const { tool, attempts } = flakyTool({ failures: 2, retryable: true, maxRetries: 3 })
		registry.register(tool)

		const { executor } = makeExecutor(registry)
		const batch = await executor.executeBatch(response('fetch_page', '{"url":"x"}'))

		expect(attempts).toHaveLength(3)
		expect(batch.results[0]?.output).toBe('fetched on attempt 3')
		expect(batch.results[0]?.isError).toBeFalsy()
	})

	it('does NOT retry unless the tool opted in — the default is 0', async () => {
		// The SDK cannot know a tool is idempotent. Silently re-running a
		// write or a payment is worse than never retrying.
		const { tool, attempts } = flakyTool({ failures: 1, retryable: true })
		registry.register(tool)

		const { executor } = makeExecutor(registry)
		const batch = await executor.executeBatch(response('fetch_page', '{"url":"x"}'))

		expect(attempts).toHaveLength(1)
		expect(batch.results[0]?.isError).toBe(true)
	})

	it('does not spend the budget on a failure that will never succeed', async () => {
		// A missing file does not appear on the second attempt; retrying
		// only delays the error the model needs to see.
		const { tool, attempts } = flakyTool({ failures: 5, retryable: false, maxRetries: 3 })
		registry.register(tool)

		const { executor } = makeExecutor(registry)
		await executor.executeBatch(response('fetch_page', '{"url":"x"}'))

		expect(attempts).toHaveLength(1)
	})

	it('gives up after the budget and hands the error to the model', async () => {
		const { tool, attempts } = flakyTool({ failures: 99, retryable: true, maxRetries: 2 })
		registry.register(tool)

		const { executor } = makeExecutor(registry)
		const batch = await executor.executeBatch(response('fetch_page', '{"url":"x"}'))

		expect(attempts).toHaveLength(3) // the first try plus two retries
		expect(batch.results[0]?.isError).toBe(true)
		expect(batch.results[0]?.output).toContain('connection reset')
	})
})
