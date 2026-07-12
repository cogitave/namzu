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
 *   - (ses_016 fix batch) A name using the pre-ses_016 `:` separator does NOT
 *     execute. It is simply unknown, and an unknown name comes back as a
 *     tool-level error result that leaves the rest of the batch — and the run —
 *     intact. This is the privilege-escalation regression: the veto, the hook and
 *     the gate match on the raw model-supplied name, so a registry that resolved
 *     `x:y` to a denied `x__y` ran the tool the policy layer had just refused.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { type ProbeRegistry, createProbeRegistry } from '../../../probe/registry.js'
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

function makeExecutor(registry: ToolRegistry, probes?: ProbeRegistry): ToolExecutor {
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
		probes ?? createProbeRegistry(),
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

	it('does not execute a legacy ":"-separated name', async () => {
		const execute = vi.fn(async () => ({ success: true, output: 'file contents' }))
		const registry = makeRegistry(execute)

		const batch = await makeExecutor(registry).executeBatch(
			buildResponse('fs-plugin:fs__read_file', { path: '/etc/hosts' }),
		)

		expect(execute).not.toHaveBeenCalled()
		expect(batch.results[0]?.output).toContain('is not registered')
	})

	it('answers an unknown tool name with an error result and keeps the batch alive', async () => {
		const execute = vi.fn(async () => ({ success: true, output: 'file contents' }))
		const registry = makeRegistry(execute)

		const response = buildResponse(COMPOSED, { path: '/etc/hosts' })
		// A batch the model emitted with one good call and one hallucinated name.
		response.message.toolCalls?.push({
			id: 'call_2',
			type: 'function',
			function: { name: 'does_not_exist', arguments: '{}' },
		})

		const batch = await makeExecutor(registry).executeBatch(response)

		// The unknown name used to reject out of `Promise.all` and abort the run,
		// taking the good call's result with it.
		expect(batch.results).toHaveLength(2)
		expect(batch.results[0]?.output).toBe('file contents')
		expect(batch.results[1]?.output).toContain('"does_not_exist" is not registered')
		expect(execute).toHaveBeenCalledOnce()
	})

	it('does not let a legacy alias slip past a veto that denied the canonical name', async () => {
		const execute = vi.fn(async () => ({ success: true, output: 'file contents' }))
		const registry = makeRegistry(execute)

		const probes = createProbeRegistry()
		const denied: string[] = []
		probes.veto(
			'tool_executing',
			(event) => {
				denied.push(event.toolName)
				return { action: 'deny', reason: 'destructive' }
			},
			{ name: 'guard', where: (event) => event.toolName === COMPOSED },
		)

		const executor = makeExecutor(registry, probes)

		// The canonical name is denied, and the veto sees exactly the string the
		// model sent.
		const canonical = await executor.executeBatch(buildResponse(COMPOSED, { path: '/etc/hosts' }))
		expect(canonical.results[0]?.output).toContain('destructive')
		expect(execute).not.toHaveBeenCalled()
		expect(denied).toEqual([COMPOSED])

		// A prompt-injected model retries under the pre-ses_016 spelling. The veto's
		// `where` does not match it — which is precisely why the registry must not
		// resolve it either. It used to: the alias was decoded AFTER the veto ran, so
		// the denied tool executed under its other name.
		const alias = await executor.executeBatch(
			buildResponse('fs-plugin:fs__read_file', { path: '/etc/hosts' }),
		)
		expect(execute).not.toHaveBeenCalled()
		expect(alias.results[0]?.output).toContain('is not registered')
	})
})
