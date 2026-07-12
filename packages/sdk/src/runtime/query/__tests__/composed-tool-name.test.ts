/**
 * Current-code invariants asserted (2026-07-12, ses_016):
 *
 *   - A `plugin__server__tool` name survives the full loop with no translation
 *     step: the name the registry advertises through `toLLMTools` is the name
 *     the model calls back, is the name `ToolExecutor.executeSingle` looks up,
 *     is the registry key. There is no alias layer, so there is nothing that can
 *     decode to a different tool than the one the security gate saw.
 *   - `runToolReview` does not touch the name either — the executor is driven
 *     with `toolCall.function.name` verbatim (this suite drives the executor,
 *     which is the seam the review phase calls into).
 *   - A name persisted under the pre-ses_016 `:` separator still executes: the
 *     registry rewrites `:` → `__` on lookup, so a replayed history resolves.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

const runId = 'run_test' as RunId
const COMPOSED = 'fs-plugin__fs__read_file'

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function makeRegistry(execute: ReturnType<typeof vi.fn>): ToolRegistry {
	const registry = new ToolRegistry({ logger: makeLogger() })
	registry.register({
		name: COMPOSED,
		description: 'Read a file through the fs MCP server',
		inputSchema: z.object({ path: z.string() }),
		execute,
	} as unknown as ToolDefinition)
	return registry
}

function buildResponse(toolName: string, args: object): ChatCompletionResponse {
	return {
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call_1',
					type: 'function',
					function: { name: toolName, arguments: JSON.stringify(args) },
				},
			],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

function makeExecutor(registry: ToolRegistry): ToolExecutor {
	const activityStore = new ActivityStore(runId, {
		enabled: true,
		trackToolCalls: true,
		trackLlmTurns: true,
	})
	const emitEvent = async (_e: RunEvent): Promise<void> => undefined
	return new ToolExecutor(
		{
			tools: registry,
			runId,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
		},
		activityStore,
		emitEvent,
		makeLogger(),
	)
}

describe('composed tool name round-trip', () => {
	it('advertises, receives back and executes the same string', async () => {
		const execute = vi.fn(async () => ({ success: true, output: 'file contents' }))
		const registry = makeRegistry(execute)

		// What the model is shown.
		const advertised = registry.toLLMTools().map((s) => s.function.name)
		expect(advertised).toEqual([COMPOSED])

		// What the model calls back — the same string, unchanged.
		const batch = await makeExecutor(registry).executeBatch(
			buildResponse(COMPOSED, { path: '/etc/hosts' }),
		)

		expect(batch.results[0]?.output).toBe('file contents')
		expect(execute).toHaveBeenCalledWith({ path: '/etc/hosts' }, expect.any(Object))
	})

	it('executes a legacy ":"-separated name from a replayed history', async () => {
		const execute = vi.fn(async () => ({ success: true, output: 'file contents' }))
		const registry = makeRegistry(execute)

		const batch = await makeExecutor(registry).executeBatch(
			buildResponse('fs-plugin:fs__read_file', { path: '/etc/hosts' }),
		)

		expect(batch.results[0]?.output).toBe('file contents')
		expect(execute).toHaveBeenCalledOnce()
	})

	it('does not silently redirect a name that resolves to nothing', async () => {
		const registry = makeRegistry(vi.fn(async () => ({ success: true, output: 'x' })))

		// Current behavior: an unknown name throws out of `ToolRegistry.execute` via
		// `getOrThrow` (which sits outside the method's try/catch). Pinned here to
		// show the legacy `:` shim does not convert an unknown name into SOME tool —
		// it only redirects to a key that actually exists.
		await expect(
			makeExecutor(registry).executeBatch(buildResponse('does_not_exist', { path: '/x' })),
		).rejects.toThrow(/Not found/)

		await expect(
			makeExecutor(registry).executeBatch(buildResponse('other:missing', { path: '/x' })),
		).rejects.toThrow(/Not found/)
	})
})
