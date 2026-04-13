import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

const mockRunId = 'run_test' as RunId

function makeLogger(): Logger {
	const stub = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function makeToolRegistry(execute: ToolRegistryContract['execute']): ToolRegistryContract {
	return {
		register: vi.fn(),
		unregister: vi.fn(),
		execute,
		get: vi.fn(() => undefined),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
		getAvailability: vi.fn(),
	} as unknown as ToolRegistryContract
}

function makePluginManager(
	executeHooks: PluginLifecycleManager['executeHooks'],
): PluginLifecycleManager {
	return { executeHooks } as unknown as PluginLifecycleManager
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

describe('ToolExecutor plugin hooks', () => {
	let activityStore: ActivityStore
	let emitted: RunEvent[]
	let emitEvent: (e: RunEvent) => Promise<void>

	beforeEach(() => {
		activityStore = new ActivityStore(mockRunId, {
			enabled: true,
			trackToolCalls: true,
			trackLlmTurns: true,
		})
		emitted = []
		emitEvent = async (e) => {
			emitted.push(e)
		}
	})

	it('continues normally when no pluginManager is configured', async () => {
		const tools = makeToolRegistry(vi.fn(async () => ({ success: true, output: 'ok' })))
		const exec = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		const batch = await exec.executeBatch(buildResponse('echo', { msg: 'hi' }))
		expect(batch.results[0]?.output).toBe('ok')
	})

	it('replaces input on pre_tool_use modify', async () => {
		const executeMock = vi.fn(async () => ({ success: true, output: 'ok' }))
		const tools = makeToolRegistry(executeMock)
		const pluginManager = makePluginManager(async (event) =>
			event === 'pre_tool_use'
				? ([{ action: 'modify', input: { replaced: true } }] as PluginHookResult[])
				: [],
		)
		const exec = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
				pluginManager,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		await exec.executeBatch(buildResponse('echo', { original: true }))
		expect(executeMock).toHaveBeenCalledWith('echo', { replaced: true }, expect.any(Object))
	})

	it('skips registry execution and synthesizes output on pre_tool_use skip', async () => {
		const executeMock = vi.fn(async () => ({ success: true, output: 'should-not-run' }))
		const tools = makeToolRegistry(executeMock)
		const pluginManager = makePluginManager(async (event) =>
			event === 'pre_tool_use'
				? ([{ action: 'skip', reason: 'policy' }] as PluginHookResult[])
				: [],
		)
		const exec = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
				pluginManager,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		const batch = await exec.executeBatch(buildResponse('echo', {}))
		expect(executeMock).not.toHaveBeenCalled()
		expect(batch.results[0]?.output).toBe('Tool echo skipped by plugin: policy')
	})

	it('overrides post_tool_use output on error action', async () => {
		const tools = makeToolRegistry(vi.fn(async () => ({ success: true, output: 'raw' })))
		const pluginManager = makePluginManager(async (event) =>
			event === 'post_tool_use'
				? ([{ action: 'error', message: 'rejected' }] as PluginHookResult[])
				: [],
		)
		const exec = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
				pluginManager,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		const batch = await exec.executeBatch(buildResponse('echo', {}))
		expect(batch.results[0]?.output).toBe('Error: rejected')
	})

	it('threads modified input through chained pre_tool_use modify hooks', async () => {
		const seenInputs: unknown[] = []
		const executeMock = vi.fn(async (_name, input) => {
			seenInputs.push(input)
			return { success: true, output: 'ok' }
		})
		const tools = makeToolRegistry(executeMock)
		const handlers = [
			async (ctx: any) => {
				seenInputs.push(['hook1-saw', ctx.toolInput])
				return { action: 'modify', input: { step: 1 } } as PluginHookResult
			},
			async (ctx: any) => {
				seenInputs.push(['hook2-saw', ctx.toolInput])
				return { action: 'modify', input: { step: 2 } } as PluginHookResult
			},
		]
		// Real PluginLifecycleManager so the modify-threading path is exercised end-to-end.
		const { PluginLifecycleManager } = await import('../../../plugin/lifecycle.js')
		const realManager = new PluginLifecycleManager({
			pluginRegistry: {} as any,
			toolRegistry: {} as any,
			log: makeLogger(),
		})
		realManager['hookHandlers'].set('pre_tool_use', [
			{ pluginId: 'p1' as any, handler: handlers[0] as any },
			{ pluginId: 'p2' as any, handler: handlers[1] as any },
		])

		const exec = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
				pluginManager: realManager,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		await exec.executeBatch(buildResponse('echo', { original: true }))
		expect(seenInputs).toEqual([
			['hook1-saw', { original: true }],
			['hook2-saw', { step: 1 }],
			{ step: 2 },
		])
	})

	it('carries modified input into synthetic skip outcome (modify -> skip chain)', async () => {
		const executeMock = vi.fn(async () => ({ success: true, output: 'should-not-run' }))
		const tools = makeToolRegistry(executeMock)
		const { PluginLifecycleManager } = await import('../../../plugin/lifecycle.js')
		const realManager = new PluginLifecycleManager({
			pluginRegistry: {} as any,
			toolRegistry: {} as any,
			log: makeLogger(),
		})
		const seenInputs: unknown[] = []
		realManager['hookHandlers'].set('pre_tool_use', [
			{
				pluginId: 'p1' as any,
				handler: (async (ctx: any) => {
					seenInputs.push(['hook1', ctx.toolInput])
					return { action: 'modify', input: { patched: true } }
				}) as any,
			},
			{
				pluginId: 'p2' as any,
				handler: (async (ctx: any) => {
					seenInputs.push(['hook2', ctx.toolInput])
					return { action: 'skip', reason: 'after patch' }
				}) as any,
			},
		])

		const exec = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
				pluginManager: realManager,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		const batch = await exec.executeBatch(buildResponse('echo', { original: true }))
		expect(executeMock).not.toHaveBeenCalled()
		expect(batch.results[0]?.output).toBe('Tool echo skipped by plugin: after patch')
		expect(seenInputs).toEqual([
			['hook1', { original: true }],
			['hook2', { patched: true }],
		])
		// Synthetic tool_executing event should carry the modified input, not the original.
		const executingEvent = emitted.find((e) => e.type === 'tool_executing')
		expect(executingEvent).toMatchObject({
			type: 'tool_executing',
			toolName: 'echo',
			input: { patched: true },
		})
	})

	it('throws on pre_tool_use retry misuse', async () => {
		const tools = makeToolRegistry(vi.fn(async () => ({ success: true, output: 'ok' })))
		const pluginManager = makePluginManager(async (event) =>
			event === 'pre_tool_use' ? ([{ action: 'retry' }] as PluginHookResult[]) : [],
		)
		const exec = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
				pluginManager,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		await expect(exec.executeBatch(buildResponse('echo', {}))).rejects.toThrow(
			/unsupported action 'retry'/,
		)
	})
})
